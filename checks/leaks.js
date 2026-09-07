/**
 * What is left of the `$.` surface, and whether any of it is unaccounted for.
 *
 * The `$.` API is a closed set, so "how much is left" is a number the tool can
 * put on itself with no reference codebase. The invariant that matters is not
 * the count but this one:
 *
 *   a converted file that has NO finding must contain NO `$.` idiom
 *
 * — because a leak with no finding is the one failure mode a reader cannot see.
 * That check has caught five real bugs across the JDBC, request and HTTP tiers
 * that reading the code did not, and it lived in a session scratchpad until now.
 *
 * Grep cannot do this: the idioms appear in comments, and in the strategy notes
 * quoted in the headers we emit. This walks the AST of the JavaScript the tool
 * actually produced.
 *
 *     node checks/leaks.js <neo-dir> [<neo-dir> …]
 */

import { convert } from '../src/convert.js';
import { parse, walk } from '../src/transform/js.js';

const roots = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!roots.length) {
  process.stderr.write('usage: node checks/leaks.js <neo-dir> [<neo-dir> …]\n');
  process.exit(2);
}

/** `$.request.parameters.get` for a member expression, or null. */
function dollarPath(node) {
  const parts = [];
  let c = node;
  while (c && c.type === 'MemberExpression') {
    parts.unshift(c.computed ? '[…]' : c.property.name ?? String(c.property.value));
    c = c.object;
  }
  if (!c || c.type !== 'Identifier' || c.name !== '$') return null;
  return `$.${parts.join('.')}`;
}

const tally = new Map();
let scanned = 0;
let unparsed = 0;
const unaccounted = [];

for (const root of roots) {
  const res = convert(root, {});
  const withFindings = new Set(res.findings.map((f) => f.file).filter(Boolean));

  for (const f of res.files) {
    if (!f.path.endsWith('.js')) continue;
    let ast;
    try {
      ast = parse(f.text, { filename: f.path, sourceType: 'module' });
    } catch {
      unparsed++;
      continue;
    }
    scanned++;

    // Only the outermost member expression of a chain counts, so
    // `$.request.parameters.get(…)` is one site and not four: recording the
    // outer one un-records the inner ones it was built from.
    walk(ast, (n) => {
      if (n.type !== 'MemberExpression') return;
      const path = dollarPath(n);
      if (!path) return;
      tally.set(path, (tally.get(path) || 0) + 1);
      for (let c = n.object; c && c.type === 'MemberExpression'; c = c.object) {
        const inner = dollarPath(c);
        if (inner) tally.set(inner, (tally.get(inner) || 0) - 1);
      }
      if (!withFindings.has(f.source)) {
        unaccounted.push(`  ${f.path}  ${path}  — the file has no finding`);
      }
    });
  }
}

const num = (s, n) => String(s).padStart(n);
console.log(`\n  ${scanned} emitted .js scanned` + (unparsed ? `, ${unparsed} did not parse` : ''));
console.log('');
for (const [k, v] of [...tally].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${num(v, 5)}  ${k}`);
}
console.log('');
if (unaccounted.length) {
  console.log(`  ${unaccounted.length} LEAK(S) WITH NO FINDING — each of these is a bug:\n`);
  for (const l of unaccounted.slice(0, 40)) console.log(l);
  console.log('');
  process.exit(1);
}
console.log('  every remaining site is in a file that carries a finding.\n');
