/**
 * Outbound HTTP: `$.net.http` / `$.web.WebRequest` → `@sap-cloud-sdk`.
 *
 * NEO spreads one call over six statements and three variables:
 *
 *     dest   = $.net.http.readDestination("TECK.Env_Config", "CmisAccessToken");
 *     client = new $.net.http.Client();
 *     req    = new $.web.WebRequest($.net.http.POST, "/oauth2/api/v1/token");
 *     req.headers.set("Content-Type", "application/json");
 *     client.request(req, dest);
 *     response = client.getResponse();
 *
 * CAP writes that as one call:
 *
 *     const response = await executeHttpRequest(
 *       { destinationName: "CmisAccessToken" },
 *       { method: "POST", url: "/oauth2/api/v1/token",
 *         headers: { "Content-Type": "application/json" } },
 *     );
 *
 * The package argument to `readDestination` is dropped: a NEO destination is
 * named inside an `.xshttpdest` package, a CF one is a flat name in the BTP
 * destination service. The shipped CF confirms it —
 * `readDestination("TECK.Env_Config", "CPI_TECK")` became
 * `{ destinationName: "CPI_TECK" }`.
 *
 * Chains are anchored on the `new $.web.WebRequest`, not on the destination:
 * a file typically reads one destination and then builds several requests
 * against it, reassigning the same `req` variable. So the request creation is
 * what there is one of per call, and everything else is found relative to it.
 *
 * Like the JDBC pass this *moves* text — a header value leaves its
 * `req.headers.set(…)` and lands inside an object literal — so it renders those
 * nodes through `ctx.inlineRewrites` and must run before the JDBC pass.
 */

import { walk, enclosingFunction, applyEdits } from './js.js';
import { dollarPath } from './request.js';
import { refPath } from './db.js';

const HTTP_METHOD = {
  GET: 'GET', POST: 'POST', PUT: 'PUT', DEL: 'DELETE', DELETE: 'DELETE',
  PATCH: 'PATCH', HEAD: 'HEAD', OPTIONS: 'OPTIONS', TRACE: 'TRACE', CONNECT: 'CONNECT',
};

const literal = (n) => (n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : null);

/** The reference a value is assigned to: `x = v` or `var x = v`. */
function assignedTo(node, parents) {
  const p = parents.get(node);
  if (!p) return null;
  if (p.type === 'VariableDeclarator' && p.init === node) return refPath(p.id);
  if (p.type === 'AssignmentExpression' && p.right === node) return refPath(p.left);
  return null;
}

/** Where `name` stops meaning what it means here: the first later assignment. */
function nextAssignment(name, scope, after) {
  let best = Infinity;
  walk(scope, (n) => {
    if (n.start <= after) return;
    const hit =
      (n.type === 'AssignmentExpression' && refPath(n.left) === name) ||
      (n.type === 'VariableDeclarator' && refPath(n.id) === name && n.init);
    if (hit && n.start < best) best = n.start;
  });
  return best;
}

/**
 * The last assignment of `name` before `before` whose value satisfies `pick`.
 * `where` further restricts which assignment nodes count.
 */
function lastAssignedBefore(name, scope, before, pick, where = () => true) {
  let best = null;
  walk(scope, (n) => {
    let value = null;
    if (n.type === 'AssignmentExpression' && refPath(n.left) === name) value = n.right;
    else if (n.type === 'VariableDeclarator' && refPath(n.id) === name && n.init) value = n.init;
    if (!value || n.start >= before) return;
    if (!pick(value) || !where(n)) return;
    if (!best || n.start > best.node.start) best = { node: n, value };
  });
  return best;
}

const isReadDestination = (n) => n.type === 'CallExpression' && dollarPath(n.callee) === 'net.http.readDestination';
const isNewClient = (n) => n.type === 'NewExpression' && dollarPath(n.callee) === 'net.http.Client';
const isNewRequest = (n) => n.type === 'NewExpression' && dollarPath(n.callee) === 'web.WebRequest';

/**
 * Every outbound call in the file, as facts. Emits nothing.
 *
 * @returns {object[]} one chain per `new $.web.WebRequest`
 */
export function analyseHttp(ast, parents) {
  const requests = [];
  const memberCalls = [];

  walk(ast, (node) => {
    if (isNewRequest(node)) {
      requests.push({ node, reqVar: assignedTo(node, parents), method: node.arguments[0], url: node.arguments[1] });
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        !node.callee.computed && node.callee.property.type === 'Identifier') {
      const on = refPath(node.callee.object);
      if (on) memberCalls.push({ node, on, method: node.callee.property.name });
    }
  });
  requests.sort((a, b) => a.node.start - b.node.start);
  memberCalls.sort((a, b) => a.node.start - b.node.start);

  return requests.map((r) => buildChain(r, { ast, parents, memberCalls, requests }));
}

function buildChain(create, { ast, parents, memberCalls, requests }) {
  const gaps = [];
  const gap = (code, message, fix) => gaps.push({ code, message, fix });
  const scope = enclosingFunction(create.node, parents) || ast;
  const start = create.node.start;

  // Only calls inside this function. XSJS leaks undeclared variables to the
  // global object, so two functions in one file routinely share the names
  // `dest`, `client` and `req` — without this bound, `getAccessToken` sees the
  // `client.request(req, dest)` belonging to `GetAccessToken` and refuses both
  // as HTTP_MULTI_SEND.
  const inScope = (n) => n.start >= scope.start && n.end <= scope.end;

  const chain = {
    reqVar: create.reqVar,
    method: null, url: create.url,
    destName: null, destVar: null, clientVar: null, responseVar: null,
    headers: [], params: [], body: null,
    nodes: { create: create.node, dest: null, client: null, send: null, response: null, closes: [], setters: [] },
    gaps, resolved: false,
  };

  if (!create.reqVar) {
    gap('REQUEST_UNNAMED', 'The `new $.web.WebRequest(…)` is not held in a variable, so the calls that configure it cannot be found.',
      'Assign it to a variable, or convert this call by hand.');
    return chain;
  }

  // The method is always one of the `$.net.http` constants in this corpus.
  const m = create.method ? dollarPath(create.method) : null;
  const name = m && m.startsWith('net.http.') ? m.slice('net.http.'.length) : null;
  if (name && Object.prototype.hasOwnProperty.call(HTTP_METHOD, name)) chain.method = HTTP_METHOD[name];
  else {
    gap('HTTP_METHOD_DYNAMIC', 'The HTTP method is not one of the `$.net.http` constants, so it cannot be read here.',
      'Replace it with a literal method name.');
  }
  if (!create.url) {
    gap('HTTP_URL_MISSING', '`new $.web.WebRequest(…)` was called without a path.', 'Check the original.');
  }

  // The request variable's lifetime bounds everything else: reusing one `req`
  // for two calls in a row is ordinary XSJS, and without this bound a chain
  // claims the next call's headers.
  const end = nextAssignment(create.reqVar, scope, start);

  const sendsForVar = memberCalls.filter(
    (c) => c.method === 'request' && inScope(c.node) &&
      c.node.arguments.length >= 1 && refPath(c.node.arguments[0]) === create.reqVar,
  );

  if (!sendsForVar.length) {
    gap('HTTP_NOT_SENT', 'This request is built but never passed to `client.request(…)` — dead code, or a bug.',
      'Delete it, or send it.');
    return chain;
  }

  // Several `new $.web.WebRequest` assigned to one variable, sent once: the URL
  // is being chosen by an if/else and the send is shared. Picking any one of
  // them would hard-code that branch's URL for every branch — a wrong
  // conversion that looks right, which is the one outcome worth refusing over.
  const siblings = requests.filter((r) => r.reqVar === create.reqVar && inScope(r.node));
  if (siblings.length > sendsForVar.length) {
    gap('HTTP_REQUEST_CONDITIONAL',
      `\`${create.reqVar}\` is built ${siblings.length} different ways but sent ${sendsForVar.length} time(s), so which request this send carries depends on a branch.`,
      'Move the branch inside the call — vary the `url`, not the request object.');
    return chain;
  }

  const sends = sendsForVar.filter((c) => c.node.start > start && c.node.start < end);
  if (!sends.length) {
    gap('HTTP_NOT_SENT', 'This request is built but never passed to `client.request(…)` — dead code, or a bug.',
      'Delete it, or send it.');
    return chain;
  }
  if (sends.length > 1) {
    gap('HTTP_MULTI_SEND', 'One request object is sent more than once, so a single call cannot stand in for it.',
      'Split it into one request per send.');
    return chain;
  }
  const send = sends[0];
  chain.nodes.send = send.node;
  chain.clientVar = send.on;

  // The destination, reached through whatever variable was passed as arg 2.
  chain.destVar = send.node.arguments[1] ? refPath(send.node.arguments[1]) : null;
  if (!chain.destVar) {
    gap('DESTINATION_UNKNOWN', '`client.request(…)` was called without a destination this tool can follow.',
      'Name the destination in a variable assigned from `$.net.http.readDestination`.');
  } else {
    // In this function first, then at module level — `var userDest =
    // $.net.http.readDestination(…)` at the top of the file, used by every
    // function below it, is the second most common shape in the corpus.
    const hit = lastAssignedBefore(chain.destVar, scope, send.node.start, isReadDestination) ||
      lastAssignedBefore(chain.destVar, ast, send.node.start, isReadDestination,
        (n) => (enclosingFunction(n, parents) || ast).type === 'Program');
    if (!hit) {
      gap('DESTINATION_UNKNOWN', `\`${chain.destVar}\` is not assigned from \`$.net.http.readDestination(…)\` anywhere before this call.`,
        'Convert this call by hand — the destination name is not in this function.');
    } else {
      chain.nodes.dest = hit.node;
      chain.destName = literal(hit.value.arguments[1]);
      if (!chain.destName) {
        gap('DESTINATION_DYNAMIC', 'The destination name is computed, so it cannot be written into the call.',
          'Use a literal destination name, or build the config object by hand.');
      }
    }
  }

  // The client, so its `new` and `close()` can go.
  if (chain.clientVar) {
    const hit = lastAssignedBefore(chain.clientVar, scope, send.node.start, isNewClient) ||
      lastAssignedBefore(chain.clientVar, ast, send.node.start, isNewClient,
        (n) => (enclosingFunction(n, parents) || ast).type === 'Program');
    if (hit) chain.nodes.client = hit.node;
    for (const c of memberCalls) {
      if (c.method === 'close' && c.on === chain.clientVar && inScope(c.node) && c.node.start > start) chain.nodes.closes.push(c.node);
    }
  }

  // Everything that configures the request, between its creation and its send.
  for (const c of memberCalls) {
    if (!inScope(c.node) || c.node.start < start || c.node.start > send.node.start) continue;
    const on = c.on;
    const args = c.node.arguments;
    if (on === `${create.reqVar}.headers` && c.method === 'set' && args.length === 2) {
      chain.headers.push({ key: args[0], value: args[1] }); chain.nodes.setters.push(c.node);
    } else if (on === `${create.reqVar}.parameters` && c.method === 'set' && args.length === 2) {
      chain.params.push({ key: args[0], value: args[1] }); chain.nodes.setters.push(c.node);
    } else if (on === create.reqVar && c.method === 'setBody' && args.length === 1) {
      chain.body = args[0]; chain.nodes.setters.push(c.node);
    } else if (on === create.reqVar || on.startsWith(`${create.reqVar}.`)) {
      gap('HTTP_REQUEST_UNHANDLED', `\`${on}.${c.method}(…)\` has no equivalent in the request config.`,
        'Convert this line by hand.');
    }
  }

  // `req.contentType = 'application/json'` is a property, not a call, and means
  // the same as setting the header.
  walk(scope, (n) => {
    if (n.type !== 'AssignmentExpression' || n.start < start || n.start > send.node.start) return;
    const target = refPath(n.left);
    if (!target || (target !== create.reqVar && !target.startsWith(`${create.reqVar}.`))) return;
    if (target === `${create.reqVar}.contentType`) {
      chain.headers.push({ key: { type: 'Literal', value: 'Content-Type' }, value: n.right });
      chain.nodes.setters.push(n);
    } else {
      gap('HTTP_REQUEST_UNHANDLED', `\`${target}\` is assigned here and has no equivalent in the request config.`,
        'Convert this line by hand.');
    }
  });

  // The response, if anything reads one.
  if (chain.clientVar) {
    const clientEnd = nextAssignment(chain.clientVar, scope, send.node.start);
    const got = memberCalls.find(
      (c) => c.method === 'getResponse' && c.on === chain.clientVar && inScope(c.node) &&
        c.node.start > send.node.start && c.node.start < clientEnd,
    );
    if (got) {
      chain.nodes.response = got.node;
      // A bare `client.getResponse();` throws the response away. That is
      // fire-and-forget, not a problem — the `await` still waits for the call.
      chain.responseVar = assignedTo(got.node, parents);
    }
  }

  chain.resolved = gaps.length === 0;
  return chain;
}

/* ------------------------------------------------------------------ emission */

/**
 * @param {object} ctx  the shared transform context from file.js
 * @returns {{edits, notes, findings, chains, awaitedNodes, needsSdk, converted, skipped}}
 */
export function httpEdits(ctx) {
  const { source, ast, parents, statementOf, removalEdit, indentOf } = ctx;
  const edits = [];
  const notes = [];
  const findings = [];
  const awaitedNodes = [];
  let converted = 0;

  const chains = analyseHttp(ast, parents);
  if (!chains.length) return { edits, notes, findings, chains, awaitedNodes, needsSdk: false, converted: 0, skipped: 0 };

  // A node's source with the earlier passes' rewrites already applied — the
  // same reason the JDBC pass needs it: these values are being moved.
  const rewrites = (ctx.inlineRewrites || []).filter((e) => e.end > e.start);
  const render = (node) => {
    if (!node) return null;
    const inner = rewrites
      .filter((e) => e.start >= node.start && e.end <= node.end)
      .map((e) => ({ start: e.start - node.start, end: e.end - node.start, text: e.text }));
    return applyEdits(source.slice(node.start, node.end), inner);
  };

  /**
   * `{ "Content-Type": "application/json" }`, laid out over lines.
   *
   * Setting one name twice is common — `headers.set("Content-Type", …)` and
   * `req.contentType = …` in the same request — and in NEO the later call wins.
   * Emitting both would be legal JavaScript with the same result, but a
   * duplicate key in the output reads like a bug, so the later one replaces it.
   */
  const objectOf = (pairs, indent) => {
    const byName = new Map();
    for (const { key, value } of pairs) {
      const k = literal(key);
      byName.set(k !== null ? JSON.stringify(k) : `[${render(key)}]`, value);
    }
    const body = [...byName].map(([name, value]) => `${indent}    ${name}: ${render(value)},`);
    return `{\n${body.join('\n')}\n${indent}  }`;
  };

  const removeStatement = (node) => {
    const stmt = statementOf(node, parents);
    if (stmt) edits.push(removalEdit(stmt, parents, source));
  };

  for (const chain of chains) {
    if (!chain.resolved) {
      const stmt = statementOf(chain.nodes.create, parents);
      if (stmt) {
        const indent = indentOf(stmt, source);
        const lines = [
          `${indent}// NEEDS HUMAN REVIEW — this outbound call was not converted.`,
          ...chain.gaps.flatMap((g) => [`${indent}//   ${g.code}: ${g.message}`, `${indent}//     ${g.fix}`]),
        ];
        edits.push({ start: stmt.start - indent.length, end: stmt.start - indent.length, text: lines.join('\n') + '\n' });
      }
      for (const g of chain.gaps) findings.push({ level: 'warning', code: g.code, message: g.message, fix: g.fix });
      continue;
    }

    // The call replaces whichever statement produced the response; with no
    // response read, it replaces the send itself.
    const anchorNode = chain.nodes.response || chain.nodes.send;
    const anchor = statementOf(anchorNode, parents);
    if (!anchor) continue;
    const indent = indentOf(anchor, source);

    const config = [`${indent}    method: ${JSON.stringify(chain.method)},`];
    if (chain.url) config.push(`${indent}    url: ${render(chain.url)},`);
    if (chain.headers.length) config.push(`${indent}    headers: ${objectOf(chain.headers, `${indent}  `)},`);
    if (chain.params.length) config.push(`${indent}    params: ${objectOf(chain.params, `${indent}  `)},`);
    if (chain.body) config.push(`${indent}    data: ${render(chain.body)},`);

    const call =
      `await executeHttpRequest(\n` +
      `${indent}  { destinationName: ${JSON.stringify(chain.destName)} },\n` +
      `${indent}  {\n${config.join('\n')}\n${indent}  },\n` +
      `${indent})`;

    // Keep the original assignment target — `response = …` or `var response = …`
    // — by replacing only the value, so the declaration reads as it did.
    edits.push({ start: anchorNode.start, end: anchorNode.end, text: call });
    awaitedNodes.push(anchorNode);

    if (chain.nodes.dest) removeStatement(chain.nodes.dest);
    if (chain.nodes.client) removeStatement(chain.nodes.client);
    removeStatement(chain.nodes.create);
    for (const s of chain.nodes.setters) removeStatement(s);
    if (chain.nodes.response) removeStatement(chain.nodes.send);
    for (const c of chain.nodes.closes) removeStatement(c);

    // The response object is axios-shaped now: `.data` is already parsed.
    if (chain.responseVar) {
      const scope = enclosingFunction(anchorNode, parents) || ast;
      const until = nextAssignment(chain.responseVar, scope, anchorNode.start);
      walk(scope, (n, parent) => {
        if (n.type !== 'CallExpression' || n.start < anchorNode.start || n.start > until) return;
        const p = refPath(n.callee);
        if (p !== `${chain.responseVar}.body.asString`) return;
        // `JSON.parse(response.body.asString())` is just the parsed body.
        if (parent && parent.type === 'CallExpression' && parent.arguments.length === 1 &&
            parent.arguments[0] === n && refPath(parent.callee) === 'JSON.parse') {
          edits.push({ start: parent.start, end: parent.end, text: `${chain.responseVar}.data` });
        } else {
          edits.push({ start: n.start, end: n.end, text: `JSON.stringify(${chain.responseVar}.data)` });
        }
      });
    }

    converted++;
  }

  if (converted) notes.push(`converted ${converted} outbound HTTP call(s) to executeHttpRequest`);
  return {
    edits, notes, findings, chains, awaitedNodes,
    needsSdk: converted > 0,
    converted,
    skipped: chains.length - converted,
  };
}
