/**
 * One `.xsjs`/`.xsjslib` file, converted.
 *
 * Every transform runs against one parse and contributes *edits*, which are
 * spliced in together at the end. That matters for more than speed: because
 * `applyEdits` sees all of them at once, two transforms claiming the same bytes
 * is caught as the bug it is instead of one quietly winning.
 *
 * The passes, in order of what they depend on:
 *
 *   db       JDBC chains        → await cds.run(…)      (transform/emitdb.js)
 *   imports  $.import + refs    → ES import statements  (transform/imports.js)
 *   request  $.request/$.response/$.session and the entry function
 *                               → req / cds.context     (transform/request.js)
 *   http     destination calls  → executeHttpRequest    (transform/http.js)
 *   async    derived            → async/await over the file's call graph
 *
 * That covers the whole `$.` surface the corpus uses, bar `$.jobs` (D6, out of
 * scope) and whatever an individual pass refuses and names.
 */

import { parse, parentMap, walk, applyEdits } from './js.js';
import {
  dbEdits, statementOf, removalEdit, indentOf, propagateAsync, dedupe,
} from './emitdb.js';
import { importEdits, exportBlock, exportedNames } from './imports.js';
import { requestEdits } from './request.js';
import { httpEdits } from './http.js';
import { constifyVars } from './vars.js';

/**
 * @param {string} source
 * @param {{filename?:string, relPath?:string, schema?:string, cfg?:object}} [opts]
 * @returns {{text:string, converted:number, skipped:number, chains:object[],
 *            imports:object[], notes:string[], findings:object[],
 *            asyncFunctions:string[], duplicateFunctions:string[]}}
 */
export function transformFile(source, opts = {}) {
  const ast = parse(source, { filename: opts.filename });
  const parents = parentMap(ast);

  // Every name that could be shadowed, so a generated one cannot collide. Member
  // property names and object keys are not bindings — counting `.CommonUtil` as
  // taken would rename the import that is about to replace it.
  const used = new Set();
  walk(ast, (n, parent) => {
    if (n.type !== 'Identifier') return;
    if (parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
    if (parent && parent.type === 'Property' && parent.key === n && !parent.computed) return;
    used.add(n.name);
  });
  const nameTaken = (base) => {
    let name = base;
    while (used.has(name)) name += '_';
    used.add(name);
    return name;
  };

  const ctx = {
    source, ast, parents, opts, nameTaken,
    reserve: (name) => used.add(name),
    statementOf, removalEdit, indentOf,
  };

  // Order matters, and only in one direction: a pass that *moves* text has to
  // run after every pass that rewrites something inside what it moves, and be
  // given those rewrites to replay into the copy (`ctx.inlineRewrites`). The
  // two movers are http (a header value leaves its setter) and db (a bind value
  // leaves its setter), so they come last, in that order.
  const imp = importEdits(ctx);
  const req = requestEdits(ctx);
  ctx.inlineRewrites = [...imp.edits, ...req.edits];
  const http = httpEdits(ctx);
  ctx.inlineRewrites = [...ctx.inlineRewrites, ...http.edits];
  const db = dbEdits(ctx);   // Tier 1, then Tier 2 over what Tier 1 refused

  let edits = [...db.edits, ...imp.edits, ...req.edits, ...http.edits];
  const notes = [...db.notes, ...imp.notes, ...req.notes, ...http.notes];
  // The JDBC gaps are findings like any other. They used to reach only `dbscan`,
  // which reads chains directly — meaning `convert`, the command that actually
  // writes the files, never said which statements it had refused.
  const findings = [
    ...imp.findings, ...req.findings, ...http.findings,
    // Tier 2 is reported whether it succeeded or not. A model that was asked and
    // declined is a different fact from one that was never asked.
    ...(db.proposals || []).map((p) => (p.accepted
      ? { level: 'note', code: 'AI_CONVERTED', message: `${p.task}: the AI tier settled this statement — ${p.kinds.join(', ')}.`, fix: 'Read the converted statement; a model decided how its interpolated values are treated.' }
      : { level: 'note', code: 'AI_DECLINED', message: `${p.task}: not converted — ${p.reason || 'no answer'}.` })),
    ...db.chains.flatMap((c) => c.gaps.map((g) => ({
      level: g.level === 'note' ? 'note' : 'warning', code: g.code, message: g.message, fix: g.fix,
    }))),
  ];

  // A function declared twice is legal in a sloppy-mode script — the second
  // quietly wins — and a SyntaxError in an ES module. XSJS files are scripts and
  // the converted handlers are modules, so this only surfaces after conversion.
  // Which of the two bodies was meant is not something to guess.
  const duplicateFns = [];
  const seenFns = new Map();
  for (const n of ast.body) {
    if (n.type !== 'FunctionDeclaration' || !n.id) continue;
    if (seenFns.has(n.id.name)) duplicateFns.push({ name: n.id.name, node: n, first: seenFns.get(n.id.name) });
    else seenFns.set(n.id.name, n);
  }
  for (const d of duplicateFns) {
    const indent = indentOf(d.node, source);
    const firstLine = source.slice(0, d.first.start).split('\n').length;
    edits.push({
      start: d.node.start - indent.length,
      end: d.node.start - indent.length,
      text:
        `${indent}// NEEDS HUMAN REVIEW — \`${d.name}\` is already declared on line ${firstLine}.\n` +
        `${indent}//   Two declarations of one name are legal in an XSJS script, where the\n` +
        `${indent}//   second silently wins, but are a SyntaxError in a CAP module. Delete\n` +
        `${indent}//   whichever one is dead.\n`,
    });
    notes.push(`\`${d.name}\` is declared twice — the file will not load until one is removed`);
    findings.push({
      level: 'warning',
      code: 'DUPLICATE_FUNCTION',
      message: `\`${d.name}\` is declared twice; an ES module rejects that.`,
      fix: 'Delete the dead declaration.',
    });
  }

  // Dedupe BEFORE working out what was removed. Two chains legitimately remove
  // the same statement — a `dest = readDestination(…)` shared by two outbound
  // calls — and two *identical* deletion edits each look "inside" the other to
  // the rule below, which dropped both and left the statement in the output.
  edits = dedupe(edits);

  // Everything the conversion removed. An edit inside a removed range is moot —
  // most often a column read in a setter whose value has already been folded
  // into the bind array — so it is dropped rather than left to collide.
  const removed = edits.filter((e) => e.text === '' && e.end > e.start);
  const isDeleted = (offset) => removed.some((r) => offset >= r.start && offset < r.end);

  const asyncPass = propagateAsync(ast, parents, [...db.awaitedNodes, ...http.awaitedNodes], source, isDeleted);
  edits.push(...asyncPass.edits);
  if (asyncPass.names.length) {
    notes.push(`made async: ${asyncPass.names.join(', ')} — callers in other files must await these`);
  }

  // An insertion is a point, not a span: one sitting exactly where a deleted
  // statement ends belongs to the code that follows it, not to what was removed.
  // Testing it with the span rule swallowed the `async ` in front of a function
  // whose preceding line had just been deleted.
  const insideRemoved = (e, r) =>
    e.start === e.end ? e.start > r.start && e.start < r.end : e.start >= r.start && e.end <= r.end;

  const kept = dedupe(edits).filter((e) => !removed.some((r) => r !== e && insideRemoved(e, r)));

  let text = applyEdits(source, kept);

  const header = [
    ...(db.converted || req.needsCds ? ['import cds from "@sap/cds";'] : []),
    ...(http.needsSdk ? ['import { executeHttpRequest } from "@sap-cloud-sdk/http-client";'] : []),
    ...imp.imports.map((i) => `import ${i.alias} from "${i.specifier}";`),
  ];
  if (header.length) text = `${header.join('\n')}\n${text}`;

  const exports = exportBlock(ast, opts.relPath);
  if (exports) text += exports;
  // A `.xsjs` is one request entry point, and CAP invokes the default export.
  if (req.defaultExport) text += `\nexport default ${req.defaultExport};\n`;

  // ES5 in, modern module out: the `var`s the splice preserved are rewritten now
  // that the file is whole (transform/vars.js). What it refuses is reported —
  // `var` surviving in the output is a fact about the NEO code, and silence
  // reads as the conversion having missed it.
  const vars = constifyVars(text, { filename: opts.filename });
  text = vars.text;
  if (vars.refused.length) {
    const reasons = [...new Set(vars.refused.map((r) => r.reason))];
    findings.push({
      level: 'note',
      code: 'VAR_KEPT',
      message: `${vars.refused.length} \`var\` declaration(s) kept — ${reasons.join('; ')}.`,
      fix: `Lines ${vars.refused.map((r) => r.line).join(', ')}. Rename or move the binding, then change it to \`let\`/\`const\` by hand; converting it as it stands would change what the code does.`,
    });
  }

  // Read the result back. A conversion that produces something the JavaScript
  // parser rejects is worse than no conversion, and the cheapest place to catch
  // it is here — so every caller gets the check, not just the one that asked.
  let loads = true;
  try {
    parse(text, { filename: opts.filename, sourceType: 'module' });
  } catch (err) {
    loads = false;
    // A duplicate declaration already reported itself above and fully explains
    // the failure; saying it twice would double-count it.
    if (!duplicateFns.length) {
      findings.push({
        level: 'blocked',
        code: 'OUTPUT_NOT_PARSEABLE',
        message: `The converted file does not parse: ${err.message.split('\n')[0]}`,
        fix: 'Report this — the conversion produced invalid JavaScript.',
      });
    }
  }

  return {
    text,
    loads,
    entry: req.defaultExport,
    exportNames: exportedNames(ast),
    needsSdk: http.needsSdk,
    converted: db.converted,
    skipped: db.skipped,
    chains: db.chains,
    proposals: db.proposals,
    imports: imp.imports,
    asyncFunctions: asyncPass.names,
    duplicateFunctions: duplicateFns.map((d) => d.name),
    findings,
    notes: [...new Set(notes)],
  };
}
