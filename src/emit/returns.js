/**
 * Every action handler answers its caller.
 *
 * `service.js` wires an alias to a library function:
 *
 *     srv.on('hsc3ogvpw9briuci', async (req) => { return await createJobBid(req); });
 *
 * so whatever that function returns is what CAP sends back. In NEO the answer
 * went out through `$.response.setBody(…)`, and `transform/request.js` turns
 * those into `return` — but only where NEO actually wrote one. A handler that
 * built its result and then dropped it on the floor used to convert into a
 * handler that resolves to `undefined`, which CAP serves as an empty 200. The
 * request succeeds and the payload is gone; nothing fails.
 *
 * This runs over the emitted tree, because only `convert` knows which functions
 * are handlers — that comes from the `.xsodata`, not from the file itself.
 *
 * Tier 1 reports; it does not invent. *Which* variable holds the answer is a
 * judgement about the code, so it is asked of a model under the Tier 2 rules
 * (src/ai/tasks.js): the model picks a name from a list this pass computed, the
 * name is checked against the AST, and this file — not the model — writes the
 * `return`. With no `--ai` backend the finding is the whole output, which is
 * the state everything was in before.
 */

import { parse, walk, applyEdits } from '../transform/js.js';
import { handlerReturn } from '../ai/tasks.js';

const isFunction = (n) => /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type);

/** The named functions this file declares, by name. */
function functionsOf(ast) {
  const out = new Map();
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) out.set(n.id.name, n);
    else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && isFunction(n.init)) {
      out.set(n.id.name, n.init);
    }
  });
  return out;
}

/** Does this function already answer with a value? Nested functions are their own. */
function returnsAValue(fn) {
  let found = false;
  walk(fn.body, (n) => {
    if (isFunction(n)) return false;              // a callback's return is not this function's
    if (n.type === 'ReturnStatement' && n.argument) found = true;
    return undefined;
  });
  return found;
}

/**
 * Names a `return` appended at the end of the body could legally use.
 *
 * Two scoping rules, and the difference matters here more than usual because
 * `transform/vars.js` has just rewritten most of this file: a `var` is
 * function-scoped, so one declared inside a `try` is still in scope at the
 * closing brace, while the `const`/`let` it became is not. Parameters are left
 * out — a handler answering with its own `req` is never the result.
 */
function candidatesOf(fn) {
  const names = [];
  for (const stmt of fn.body.body || []) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations) if (d.id.type === 'Identifier') names.push(d.id.name);
  }
  walk(fn.body, (n) => {
    if (isFunction(n)) return false;
    if (n.type === 'VariableDeclaration' && n.kind === 'var') {
      for (const d of n.declarations) if (d.id.type === 'Identifier') names.push(d.id.name);
    }
    return undefined;
  });
  return [...new Set(names)];
}

/** Where a `return` goes: just before the body's closing brace, at body indent. */
function insertionFor(fn, text) {
  const at = fn.body.end - 1;
  const last = (fn.body.body || [])[fn.body.body.length - 1];
  let indent = '  ';
  if (last) {
    let s = last.start;
    while (s > 0 && text[s - 1] !== '\n') s--;
    indent = /^[ \t]*/.exec(text.slice(s, last.start))[0] || '  ';
  }
  return { at, indent };
}

/**
 * @param {{path:string, text:string, role:string}[]} files  everything `convert` emitted
 * @param {{alias:string, fn:string, target:string}[]} wired  the .xsodata handler bindings
 * @param {{name:string, ask:Function}|null} ai               Tier 2 backend, or null
 * @returns {{added:number, asked:number, findings:object[]}}
 */
export function ensureHandlerReturns(files, wired, ai = null) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const findings = [];
  let added = 0;
  // Distinct from `added`: this counts every handler actually put to the
  // model, whether it answered `unknown`, was rejected twice, or was never
  // reachable — the number a caller needs to tell "nothing was eligible" from
  // "the backend never worked" (see convert.js's AI_TIER_SUMMARY).
  let asked = 0;

  // One entry per handler function, however many aliases point at it.
  const seen = new Set();
  const perFile = new Map();          // path -> { fn, alias }[]
  for (const b of wired) {
    const k = `${b.target}::${b.fn}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!perFile.has(b.target)) perFile.set(b.target, []);
    perFile.get(b.target).push(b);
  }

  for (const [path_, bindings] of perFile) {
    const file = byPath.get(path_);
    if (!file) continue;              // the library failed to convert; already reported

    let ast;
    try {
      ast = parse(file.text, { filename: path_, sourceType: 'module' });
    } catch {
      continue;                       // reported by the re-parse gate; not ours to edit
    }
    const fns = functionsOf(ast);
    const edits = [];
    const accepted = [];

    for (const b of bindings) {
      const fn = fns.get(b.fn);
      if (!fn || fn.body.type !== 'BlockStatement') continue;   // missing is HANDLER_EXPORT_MISSING's finding
      if (returnsAValue(fn)) continue;

      const candidates = candidatesOf(fn);
      const eligible = ai && candidates.length;
      if (eligible) asked++;
      const answer = eligible
        ? askForReturn(ai, { fn, name: b.fn, text: file.text, candidates, file: path_ })
        : null;

      if (!answer) {
        findings.push({
          level: 'warning',
          code: 'HANDLER_NO_RETURN',
          message: `${path_}: ${b.fn}() serves action "${b.alias}" and returns nothing, so CAP answers the caller with an empty body.`,
          file: path_,
          fix: candidates.length
            ? `NEO sent its answer with \`$.response.setBody\`; this function never did. Add \`return <the result>;\` — the values in scope at the end are: ${candidates.join(', ')}.`
            : 'NEO sent its answer with `$.response.setBody`; this function never did. Decide what the caller should receive and return it.',
        });
        continue;
      }

      const { at, indent } = insertionFor(fn, file.text);
      edits.push({
        start: at,
        end: at,
        text:
          `${indent}// AI-CHOSEN RETURN — this function returned nothing, so the action answered\n` +
          `${indent}//   with an empty body. A model picked \`${answer}\` from the values in scope\n` +
          `${indent}//   here as the result. Check it is the one the caller expects.\n` +
          `${indent}return ${answer};\n`,
      });
      accepted.push({ fn: b.fn, alias: b.alias, variable: answer });
    }

    if (!edits.length) continue;
    const next = applyEdits(file.text, edits);
    try {
      parse(next, { filename: path_, sourceType: 'module' });
    } catch {
      // Never ship a file this pass broke; the empty answer is the lesser bug.
      continue;
    }
    file.text = next;
    added += accepted.length;
    for (const a of accepted) {
      findings.push({
        level: 'note',
        code: 'AI_RETURN_ADDED',
        message: `${path_}: ${a.fn}() served action "${a.alias}" and returned nothing; a model chose \`${a.variable}\` as its result.`,
        file: path_,
        fix: 'Read the added `return` — a model decided what this endpoint answers with.',
      });
    }
  }

  return { added, asked, findings };
}

/** One Tier 2 question, with one retry. Returns the variable name, or null. */
function askForReturn(ai, ctx) {
  let prompt = handlerReturn.prompt(ctx);
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      raw = ai.ask(prompt);
    } catch {
      return null;                    // unreachable model — same answer as no model
    }
    const verdict = handlerReturn.validate(handlerReturn.parse(raw), ctx);
    if (verdict.variable) return verdict.variable;
    if (!verdict.reject) return null; // the model said `unknown`, which is an answer
    prompt = `${prompt}\n\nYour previous answer was rejected: ${verdict.reject}\nAnswer again, JSON only.`;
  }
  return null;
}

export { returnsAValue, candidatesOf };
