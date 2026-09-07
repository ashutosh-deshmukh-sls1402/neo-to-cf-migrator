/**
 * What is each refusal actually worth?
 *
 * This measurement has redirected the plan three times (§20, §22, §24) and it
 * lives in the repo because every one of those times it took under an hour and
 * replaced the planned work with something smaller and deterministic.
 *
 * The rule it exists to enforce: **a gap code's site count is not its value.**
 * A statement converts only when *every* blocker on it is gone, so the ceiling
 * for fixing one code is the number of chains where it is the ONLY blocker.
 * `BIND_BATCHED` fires 59 times and is worth one statement.
 *
 * Run it before building anything for a bucket of refusals, then read five of
 * the statements it points at.
 *
 *     node checks/ceiling.js <neo-dir> [<neo-dir> …]
 *     node checks/ceiling.js <neo-dir> --code SQL_DYNAMIC     # list those files
 */

import fs from 'node:fs';
import path from 'node:path';
import { discover } from '../src/core/intake.js';
import { KIND } from '../src/core/artifacts.js';
import { analyseDb } from '../src/transform/db.js';
import { indexFromIntake } from '../src/parse/procsig.js';

const args = process.argv.slice(2);
const codeAt = args.indexOf('--code');
const only = codeAt === -1 ? null : args[codeAt + 1];
// `--code X` consumes X, so it is not a root. Filtering only on the leading `--`
// left the code name in the list and it was read as a directory.
const roots = args.filter((a, i) => !a.startsWith('--') && !(codeAt !== -1 && i === codeAt + 1));

if (!roots.length) {
  process.stderr.write('usage: node checks/ceiling.js <neo-dir> [<neo-dir> …] [--code CODE]\n');
  process.exit(2);
}

const total = { chains: 0, resolved: 0 };
const raw = new Map();       // code -> gaps seen
const ceiling = new Map();   // code -> chains where it is the only blocker
const sites = [];            // for --code

for (const root of roots) {
  const intake = discover(root, {});
  const procs = indexFromIntake(root, intake);
  for (const unit of intake.units) {
    if (unit.kind !== KIND.LIBRARY) continue;
    for (const name of unit.files) {
      const rel = [unit.neoDir, name].filter(Boolean).join('/');
      let res;
      try {
        res = analyseDb(fs.readFileSync(path.join(root, rel), 'utf8'), { filename: rel, procs, schema: intake.schema });
      } catch {
        continue;                       // reported by dbscan, not here
      }
      for (const chain of res.chains) {
        total.chains++;
        if (chain.resolved) { total.resolved++; continue; }
        const blockers = chain.gaps.filter((g) => g.level !== 'note');
        for (const g of blockers) raw.set(g.code, (raw.get(g.code) || 0) + 1);
        const codes = new Set(blockers.map((g) => g.code));
        if (codes.size !== 1) continue;
        const [code] = codes;
        ceiling.set(code, (ceiling.get(code) || 0) + 1);
        if (code === only) {
          sites.push(`  ${rel}  ${(chain.sql.text || '(no sql)').replace(/\s+/g, ' ').slice(0, 100)}`);
        }
      }
    }
  }
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log(`\n  chains ${total.chains}   resolved ${total.resolved}   refused ${total.chains - total.resolved}\n`);
console.log(`  ${pad('CODE', 26)}${num('RAW', 5)}${num('CEILING', 9)}`);
console.log(`  ${'─'.repeat(40)}`);
const codes = [...new Set([...raw.keys(), ...ceiling.keys()])]
  .sort((a, b) => (ceiling.get(b) || 0) - (ceiling.get(a) || 0) || (raw.get(b) || 0) - (raw.get(a) || 0));
for (const c of codes) {
  console.log(`  ${pad(c, 26)}${num(raw.get(c) || 0, 5)}${num(ceiling.get(c) || 0, 9)}`);
}
console.log('\n  RAW     = how often the gap is raised.  Not its value.');
console.log('  CEILING = chains where it is the ONLY blocker — the most that');
console.log('            fixing it perfectly could ever convert.\n');

if (only) {
  console.log(`  ${only} — the ${sites.length} chain(s) it alone blocks:\n`);
  for (const s of sites) console.log(s);
  console.log('');
}
