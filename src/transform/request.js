/**
 * The request boundary: `$.request` / `$.response` / `$.session` and the entry
 * function.
 *
 * This looked like it needed a judgement per file. It does not — the corpus
 * settles it. Across both trees, `$.request` appears in 184 places and every one
 * is in a `.xsjs`; `$.response` appears 757 times and 745 are in a `.xsjs`;
 * `$.session` appears 59 times and 57 are in a `.xsjslib`. So:
 *
 *   - a `.xsjs` is a request entry point: one of its functions is called at top
 *     level, and that one becomes `export default fn(req)`.
 *   - a `.xsjslib` is a library, and `service.js` already passes `req` to the
 *     one function the `.xsodata` names.
 *
 * What made this look harder than it is: a third of the `$.request`/`$.response`
 * sites are in *helpers* the entry function calls, where the `req` parameter is
 * not in scope. CAP answers that itself — it keeps the current request in
 * async-local storage as `cds.context`, reachable from anywhere including inside
 * a library. So `req` where we know it is bound, `cds.context` everywhere else,
 * and both name the same object. No per-file judgement is needed at all.
 *
 * NEO dispatches by hand:
 *
 *     function processRequest() {
 *       switch ($.request.method) {
 *         case $.net.http.POST: $.response.setBody(JSON.stringify(handlePost())); break;
 *         default: $.response.status = $.net.http.METHOD_NOT_ALLOWED; …
 *       }
 *     }
 *     processRequest();
 *
 * CAP routes, so the switch is dead weight — `req.event` is the action name and
 * never "POST", which means the old default branch is the only one that could
 * ever run. 53 of the 54 method switches in the corpus have exactly one real
 * case, so collapsing to it is deterministic. The two-case one gets a finding.
 *
 * Every rewrite here is emitted as edits *around* the interesting sub-expression
 * rather than as replacement text for the whole statement, so that the db and
 * import passes can still edit what is inside it. That is why the code reads as
 * pairs of edits bracketing an argument.
 */

import { walk } from './js.js';

/** The `$.a.b.c` path of a member expression rooted at `$`, or null. */
export function dollarPath(node) {
  const segs = [];
  let cur = node;
  while (cur && cur.type === 'MemberExpression' && !cur.computed && cur.property.type === 'Identifier') {
    segs.unshift(cur.property.name);
    cur = cur.object;
  }
  return cur && cur.type === 'Identifier' && cur.name === '$' && segs.length ? segs.join('.') : null;
}

/** `$.net.http.OK` and friends. XSJS spells DELETE as DEL. */
const HTTP_STATUS = {
  CONTINUE: 100, OK: 200, CREATED: 201, ACCEPTED: 202, NO_CONTENT: 204, PARTIAL_CONTENT: 206,
  MOVED_PERMANENTLY: 301, FOUND: 302, NOT_MODIFIED: 304,
  BAD_REQUEST: 400, UNAUTHORIZED: 401, PAYMENT_REQUIRED: 402, FORBIDDEN: 403, NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405, NOT_ACCEPTABLE: 406, REQUEST_TIMEOUT: 408, CONFLICT: 409, GONE: 410,
  PRECONDITION_FAILED: 412, UNSUPPORTED_MEDIA_TYPE: 415, UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500, NOT_IMPLEMENTED: 501, BAD_GATEWAY: 502, SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};
const HTTP_METHOD = {
  GET: 'GET', POST: 'POST', PUT: 'PUT', DEL: 'DELETE', DELETE: 'DELETE',
  PATCH: 'PATCH', HEAD: 'HEAD', OPTIONS: 'OPTIONS', TRACE: 'TRACE', CONNECT: 'CONNECT',
};

/** The numeric status a node denotes, or null if it is not one. */
function statusValue(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  const p = dollarPath(node);
  if (!p || !p.startsWith('net.http.')) return null;
  const name = p.slice('net.http.'.length);
  return Object.prototype.hasOwnProperty.call(HTTP_STATUS, name) ? HTTP_STATUS[name] : null;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The statement list a statement belongs to, and where in it. */
function siblings(stmt, parents) {
  const p = parents.get(stmt);
  if (!p) return null;
  const list = p.type === 'SwitchCase' ? p.consequent : p.body;
  if (!Array.isArray(list)) return null;
  const index = list.indexOf(stmt);
  return index < 0 ? null : { list, index, holder: p };
}

const isCallTo = (n, path) =>
  n.type === 'CallExpression' && dollarPath(n.callee) === path;

/**
 * @param {object} ctx  the shared transform context from file.js
 * @returns {{edits:object[], notes:string[], findings:object[], needsCds:boolean,
 *            defaultExport:string|null, entryName:string|null}}
 */
export function requestEdits(ctx) {
  const { source, ast, parents, opts, statementOf, indentOf } = ctx;
  const edits = [];
  const notes = [];
  const findings = [];
  let needsCds = false;

  // Ranges the structural rewrites below take over wholesale — the scaffolding
  // of a collapsed switch, the two statements a `req.reject` replaces. A leaf
  // rewrite inside one of them (`$.net.http.INTERNAL_SERVER_ERROR` is both a
  // status constant and the right-hand side of an assignment that is going
  // away) would claim the same bytes twice, which `applyEdits` treats as the
  // bug it is. So the structural passes run first and record what they took.
  const claimed = [];
  const isClaimed = (node) => claimed.some((r) => node.start >= r[0] && node.end <= r[1]);
  const claim = (start, end, text) => { claimed.push([start, end]); edits.push({ start, end, text }); };

  const relPath = opts.relPath || opts.filename || '';
  const isEntryFile = /\.xsjs$/i.test(relPath);

  const warn = (code, message, fix) => findings.push({ level: 'warning', code, message, fix });

  /**
   * A `// NEEDS HUMAN REVIEW` block in front of a statement we are leaving alone.
   *
   * Inserted *at* the statement rather than at the start of its line: a comment
   * for the first statement of a collapsed switch case would otherwise back up
   * over the indent into the range the collapse already claimed.
   */
  const review = (stmt, lines) => {
    const indent = indentOf(stmt, source);
    const text = ['// NEEDS HUMAN REVIEW — ' + lines[0], ...lines.slice(1).map((l) => '//   ' + l)]
      .join(`\n${indent}`) + `\n${indent}`;
    edits.push({ start: stmt.start, end: stmt.start, text });
  };

  // ---------------------------------------------------------------- the entry

  // One top-level bare call naming a function declared in this file is the entry
  // point. 57 of the 110 `.xsjs` in the corpus look exactly like that; the rest
  // have theirs commented out (they were driven by an `.xsjob`, which is out of
  // scope) and get a finding instead.
  const declared = new Map();
  for (const n of ast.body) if (n.type === 'FunctionDeclaration' && n.id) declared.set(n.id.name, n);

  const topCalls = ast.body.filter(
    (n) => n.type === 'ExpressionStatement' &&
      n.expression.type === 'CallExpression' &&
      n.expression.callee.type === 'Identifier' &&
      declared.has(n.expression.callee.name),
  );

  let entryFn = null;
  let entryName = null;
  if (isEntryFile && topCalls.length === 1) {
    entryName = topCalls[0].expression.callee.name;
    entryFn = declared.get(entryName);
  }

  // Does anything in this file actually need a request object?
  let needsReq = false;
  walk(ast, (n) => {
    const p = n.type === 'MemberExpression' ? dollarPath(n) : null;
    if (p && (p === 'request' || p.startsWith('request.') || p === 'response' || p.startsWith('response.'))) needsReq = true;
  });

  let hasReq = false;
  if (entryFn) {
    if (entryFn.params.length) {
      warn('ENTRY_HAS_PARAMETERS',
        `\`${entryName}\` is the request entry point but already takes ${entryFn.params.length} parameter(s), so \`req\` was not added.`,
        'Add `req` as the first parameter by hand and update its callers.');
    } else {
      // Insert into the empty parameter list: the `(` after the function name.
      const open = source.indexOf('(', entryFn.id.end);
      edits.push({ start: open + 1, end: open + 1, text: 'req' });
      hasReq = true;
    }
    // The top-level invocation is what CAP's router does now.
    edits.push({ ...ctx.removalEdit(topCalls[0], parents, source), text: '' });
    notes.push(`\`${entryName}\` is the request entry point — exported as the default`);
  } else if (isEntryFile && needsReq) {
    warn('NO_REQUEST_ENTRY',
      topCalls.length
        ? `This file calls ${topCalls.length} top-level functions, so which one CAP should invoke is ambiguous.`
        : 'No top-level call, so nothing identifies the request entry point (often the dispatch is commented out because an .xsjob drove it).',
      'Pick the entry function, give it a `req` parameter and `export default` it.');
  }

  /**
   * How this node should reach the request.
   *
   * `req` is a parameter of the entry function, so it is only in scope inside
   * it — and roughly a third of the `$.request`/`$.response` sites are in
   * helpers the entry calls. CAP keeps the current request in
   * async-local storage as `cds.context`, which is in scope everywhere,
   * including inside a `.xsjslib`. So: `req` where we know it is bound,
   * `cds.context` everywhere else. Both name the same object.
   */
  const inEntry = (node) => {
    if (!entryFn) return false;
    for (let n = node; n; n = parents.get(n)) if (n === entryFn) return true;
    return false;
  };
  const reqRef = (node) => {
    if (hasReq && inEntry(node)) return 'req';
    needsCds = true;
    return 'cds.context';
  };
  let rejectedOutsideEntry = false;
  const reject = (node) => {
    const ref = reqRef(node);
    if (ref !== 'req') rejectedOutsideEntry = true;
    return `${ref}.reject`;
  };

  // -------------------------------------------------- the $.request.method switch

  const switches = [];
  walk(ast, (n) => {
    if (n.type === 'SwitchStatement' && dollarPath(n.discriminant) === 'request.method') switches.push(n);
  });

  for (const sw of switches) {
    const real = sw.cases.filter((c) => c.test);
    if (real.length !== 1) {
      review(sw, [
        `This switch dispatches on \`$.request.method\` across ${real.length} methods.`,
        'CAP routes by event name, so `req.event` is the action name and never "GET"/"POST".',
        'Split this into one handler per action, or branch on `req.event`.',
      ]);
      warn('MULTI_METHOD_DISPATCH',
        `A \`$.request.method\` switch handles ${real.length} methods; CAP routes one action per handler.`,
        'Split it into one handler per action.');
      continue;
    }
    const body = real[0].consequent;
    if (!body.length) {
      warn('EMPTY_METHOD_CASE', 'The only case of a `$.request.method` switch is empty.', 'Check the original.');
      continue;
    }
    // Keep the case body verbatim so the db and import passes can still edit it;
    // delete only the scaffolding on either side of it.
    let last = body.length - 1;
    while (last >= 0 && body[last].type === 'BreakStatement') last--;
    if (last < 0) {
      warn('EMPTY_METHOD_CASE', 'The only case of a `$.request.method` switch does nothing but break.', 'Check the original.');
      continue;
    }
    const midBreak = body.slice(0, last).some((s) => s.type === 'BreakStatement');
    if (midBreak) {
      review(sw, [
        'The only case of this `$.request.method` switch breaks early, so removing the switch would leave a `break` with nothing to break out of.',
        'Restructure the case body, then delete the switch.',
      ]);
      warn('METHOD_CASE_EARLY_BREAK', 'A `$.request.method` case breaks before its end, so the switch cannot be removed mechanically.', 'Restructure the case body by hand.');
      continue;
    }
    const indent = indentOf(sw, source);
    const method = HTTP_METHOD[String(dollarPath(real[0].test) || '').slice('net.http.'.length)] || 'GET';
    claim(sw.start, body[0].start,
      `// CAP routes by event, so the old \`$.request.method\` switch is gone —\n` +
      `${indent}// \`req.event\` is the action name and never "${method}".\n${indent}`);
    claim(body[last].end, sw.end, '');
    notes.push('collapsed the $.request.method switch — CAP routes');
  }

  // ------------------------------------------------------------ leaf rewrites

  const replace = (node, text) => edits.push({ start: node.start, end: node.end, text });
  /** Rewrite around `keep` so its own contents stay editable. */
  const bracket = (node, keep, before, after) => {
    edits.push({ start: node.start, end: keep.start, text: before });
    edits.push({ start: keep.end, end: node.end, text: after });
  };

  // Deferred: it must not touch bytes the response pass below is going to take.
  const leafPass = () => walk(ast, (node, parent) => {
    if ((node.type === 'CallExpression' || node.type === 'MemberExpression') && isClaimed(node)) return false;

    // $.session.getUsername() -> cds.context.user.id  (valid in a library too)
    if (isCallTo(node, 'session.getUsername')) {
      replace(node, 'cds.context.user.id');
      needsCds = true;
      return;
    }

    if (node.type === 'CallExpression') {
      const callee = dollarPath(node.callee);

      // JSON.parse($.request.body.asString()) -> req.data
      if (
        node.callee.type === 'MemberExpression' && !node.callee.computed &&
        node.callee.object.type === 'Identifier' && node.callee.object.name === 'JSON' &&
        node.callee.property.name === 'parse' &&
        node.arguments.length === 1 && isCallTo(node.arguments[0], 'request.body.asString')
      ) {
        replace(node, `${reqRef(node)}.data`);
        return false;
      }

      if (callee === 'request.body.asString') {
        replace(node, `JSON.stringify(${reqRef(node)}.data)`);
        return false;
      }

      // $.request.parameters.get("NAME") -> req.data.NAME
      if (callee === 'request.parameters.get') {
        const arg = node.arguments[0];
        const name = arg && arg.type === 'Literal' && typeof arg.value === 'string' ? arg.value : null;
        if (!name) {
          warn('PARAMETER_NAME_DYNAMIC', 'A `$.request.parameters.get(…)` name is computed, so it cannot be turned into a `req.data` field.', 'Rewrite this access by hand.');
          return false;
        }
        const r = reqRef(node);
        replace(node, IDENT.test(name) ? `${r}.data.${name}` : `${r}.data[${JSON.stringify(name)}]`);
        return false;
      }

      if (callee === 'util.codec.encodeBase64' && node.arguments.length === 1) {
        bracket(node, node.arguments[0], 'Buffer.from(', ').toString("base64")');
        return;
      }
      if (callee === 'util.codec.decodeBase64' && node.arguments.length === 1) {
        bracket(node, node.arguments[0], 'Buffer.from(', ', "base64").toString()');
        return;
      }
      if (callee === 'response.headers.set') {
        const stmt = statementOf(node, parents);
        if (stmt) {
          review(stmt, [
            'CAP owns the response headers; `$.response.headers.set` has no direct equivalent.',
            'If the header is really needed, reach it through `cds.context.http.res`.',
          ]);
        }
        warn('RESPONSE_HEADER_SET', '`$.response.headers.set` has no CAP equivalent on the handler.', 'Set it on `cds.context.http.res`, or drop it.');
        return false;
      }
    }

    if (node.type !== 'MemberExpression') return;
    // Only the outermost `$.…` chain — but `$.request.parameters[0]` ends the
    // chain at `parameters`, because a computed access is not part of the path.
    if (parent && parent.type === 'MemberExpression' && parent.object === node && !parent.computed) return;
    const p = dollarPath(node);
    if (!p) return;

    // `$.request.method` outside a switch we already collapsed.
    if (p === 'request.method') {
      replace(node, `${reqRef(node)}.event`);
      return false;
    }

    // The payload, reached without `.asString()` — usually the `body ? … : …` guard.
    if (p === 'request.body') {
      replace(node, `${reqRef(node)}.data`);
      return false;
    }

    // `$.request.parameters[0].value` — positional, so the name is not in the source.
    if (p === 'request.parameters' || p.startsWith('request.parameters')) {
      const stmt = statementOf(node, parents);
      if (stmt) {
        review(stmt, [
          '`$.request.parameters` is read by position here, so the parameter name is not in this file.',
          'CAP passes named fields: use `req.data.<NAME>`.',
        ]);
      }
      warn('PARAMETER_BY_POSITION', '`$.request.parameters` is indexed by position, so the parameter name cannot be recovered.', 'Replace with `req.data.<NAME>` using the name from the .xsodata or the caller.');
      return false;
    }

    if (p.startsWith('net.http.')) {
      const name = p.slice('net.http.'.length);
      if (Object.prototype.hasOwnProperty.call(HTTP_STATUS, name)) { replace(node, String(HTTP_STATUS[name])); return false; }
      if (Object.prototype.hasOwnProperty.call(HTTP_METHOD, name)) { replace(node, JSON.stringify(HTTP_METHOD[name])); return false; }
      // readDestination / Client / the rest of the HTTP client — a separate pass.
      return false;
    }
    return undefined;
  });

  // -------------------------------------------------------- response statements

  // Statement-level, and always a whole statement: all 193 `$.response.setBody`
  // calls in the corpus are the entire expression statement, never nested.
  const folded = new Set();   // status statements already consumed by the pair rules

  const setBodyOf = (stmt) =>
    stmt && stmt.type === 'ExpressionStatement' && isCallTo(stmt.expression, 'response.setBody')
      ? stmt.expression : null;
  const statusOf = (stmt) =>
    stmt && stmt.type === 'ExpressionStatement' && stmt.expression.type === 'AssignmentExpression' &&
    stmt.expression.operator === '=' && dollarPath(stmt.expression.left) === 'response.status'
      ? stmt.expression : null;

  const stmts = [];
  walk(ast, (n) => { if (n.type === 'ExpressionStatement') stmts.push(n); });

  for (const stmt of stmts) {
    const assign = statusOf(stmt);
    if (!assign) continue;
    const code = statusValue(assign.right);
    if (code === null) {
      review(stmt, ['`$.response.status` is set to something this tool cannot read as an HTTP code.', 'Convert to `req.reject(<code>, <message>)` by hand.']);
      warn('RESPONSE_STATUS_DYNAMIC', '`$.response.status` is assigned a computed value.', 'Convert to `req.reject(…)` by hand.');
      folded.add(stmt);
      continue;
    }
    if (code < 400) {
      // A success code is CAP's to choose; the assignment simply goes.
      { const r = ctx.removalEdit(stmt, parents, source); claim(r.start, r.end, ''); }
      folded.add(stmt);
      continue;
    }

    const sib = siblings(stmt, parents);
    const next = sib ? sib.list[sib.index + 1] : null;
    const body = setBodyOf(next);
    if (body) {
      // `status = C; setBody(x);`  ->  `return req.reject(C, x);`
      const arg = body.arguments[0];
      if (arg) {
        claim(stmt.start, arg.start, `return ${reject(stmt)}(${code}, `);
        claim(arg.end, next.end, ');');
      } else {
        claim(stmt.start, next.end, `return ${reject(stmt)}(${code});`);
      }
      folded.add(stmt); folded.add(next);
      continue;
    }
    if (next && next.type === 'ReturnStatement') {
      // `status = C; return x;`  ->  `return req.reject(C, x);`
      if (next.argument) {
        claim(stmt.start, next.argument.start, `return ${reject(stmt)}(${code}, `);
        claim(next.argument.end, next.end, ');');
      } else {
        claim(stmt.start, next.end, `return ${reject(stmt)}(${code});`);
      }
      folded.add(stmt); folded.add(next);
      continue;
    }
    if (!next) {
      claim(stmt.start, stmt.end, `return ${reject(stmt)}(${code});`);
      folded.add(stmt);
      continue;
    }
    review(stmt, [
      `\`$.response.status\` is set to ${code} but the statements after it keep running.`,
      '`req.reject(…)` returns, so where it belongs is a judgement about this flow.',
    ]);
    warn('RESPONSE_STATUS_MIDBLOCK', `\`$.response.status = ${code}\` is followed by more code, so it cannot be turned into \`req.reject\` mechanically.`, 'Decide where the request should stop, then call `req.reject(…)` there.');
    folded.add(stmt);
  }

  for (const stmt of stmts) {
    if (folded.has(stmt)) continue;

    // contentType: CAP negotiates it.
    const assign = stmt.expression.type === 'AssignmentExpression' && stmt.expression.operator === '='
      ? stmt.expression : null;
    if (assign && dollarPath(assign.left) === 'response.contentType') {
      const v = assign.right.type === 'Literal' ? String(assign.right.value) : null;
      if (v && !/^application\/json/i.test(v)) {
        warn('RESPONSE_CONTENT_TYPE', `\`$.response.contentType\` was "${v}"; CAP returns JSON unless the action says otherwise.`,
          `If "${v}" matters, declare it on the action in the .cds.`);
      }
      { const r = ctx.removalEdit(stmt, parents, source); claim(r.start, r.end, ''); }
      continue;
    }

    const body = setBodyOf(stmt);
    if (!body) continue;

    const sib = siblings(stmt, parents);
    let tail = !sib;
    if (sib) {
      const rest = sib.list.slice(sib.index + 1);
      tail = rest.every((s) => s.type === 'BreakStatement');
      // The `break` after it would be orphaned once the switch around it is gone.
      for (const s of rest) if (s.type === 'BreakStatement') claim(s.start, s.end, ';');
    }
    if (!tail) {
      review(stmt, [
        '`$.response.setBody` becomes a `return`, but code follows it here.',
        'Decide whether the request really ends at this line.',
      ]);
      warn('RESPONSE_BODY_MIDBLOCK', '`$.response.setBody` is followed by more code, so turning it into `return` would change the flow.', 'Move it to the end of the branch, then convert.');
      continue;
    }

    // In a catch clause the body is an error message; returning it as a success
    // payload would report a failure as a 200.
    let inCatch = false;
    for (let n = parents.get(stmt); n; n = parents.get(n)) {
      if (n.type === 'CatchClause') { inCatch = true; break; }
      if (/Function/.test(n.type)) break;
    }
    const arg = body.arguments[0];
    if (!arg) {
      claim(stmt.start, stmt.end, inCatch ? `return ${reject(stmt)}(500);` : 'return;');
      continue;
    }
    if (inCatch) {
      claim(stmt.start, arg.start, `return ${reject(stmt)}(500, `);
      claim(arg.end, stmt.end, ');');
      warn('CATCH_STATUS_ASSUMED', 'A `$.response.setBody` in a catch block became `req.reject(500, …)`; the original set no status.', 'Check 500 is the code you want.');
    } else {
      claim(stmt.start, arg.start, 'return ');
      claim(arg.end, stmt.end, ';');
    }
  }

  // `$.response` used as a whole, or any `$.response.*` we did not handle.
  walk(ast, (n, parent) => {
    if (n.type !== 'MemberExpression') return;
    if (parent && parent.type === 'MemberExpression' && parent.object === n) return;
    const p = dollarPath(n);
    if (!p || !p.startsWith('response')) return;
    if (/^response\.(setBody|status|contentType|headers)/.test(p)) return;
    warn('RESPONSE_UNHANDLED', `\`$.${p}\` has no CAP equivalent on the handler.`, 'Convert this line by hand.');
  });

  // Last, so it can see everything the structural passes already took.
  leafPass();

  if (rejectedOutsideEntry) {
    warn('REJECT_OUTSIDE_ENTRY',
      'An error response was rewritten as `cds.context.reject(…)` outside the entry function. `cds.context` is the inbound request for a handler invoked by CAP, but not for one called from another service.',
      'If this library is ever called service-to-service, pass `req` in and use it instead.');
  }

  if (edits.length) notes.push('rewrote the request/response boundary');

  return {
    edits, notes, findings, needsCds,
    entryName,
    defaultExport: entryFn ? entryName : null,
  };
}
