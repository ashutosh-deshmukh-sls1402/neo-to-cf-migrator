/**
 * The whole sweep, in one command.
 *
 * §23 found five defects the moment a real CDS compiler saw the output, and it
 * found them because someone ran `cds build` by hand, once. A check that is
 * only ever run by hand is a check that stops being run, so this is it as a
 * command: convert both corpora, re-parse the emitted JavaScript, and put the
 * result through CAP's own compiler. It exits non-zero if anything fails.
 *
 *     node checks/verify.js <neo-dir> [<neo-dir> …] [options]
 *       --expect <cf-dir>   score the FIRST corpus against a hand-migrated tree
 *       --cds <path>        the cds binary (default: the one on PATH)
 *       --out <dir>         where to convert to (default: a temp dir)
 *       --no-build          skip the CDS build (when cds-dk is not installed)
 *
 * `cds build --production` needs @sap/cds-dk. If it is not installed, a shipped
 * CF project has a copy:
 *     --cds <cf-project>/node_modules/.bin/cds
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const roots = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const expect = flag('--expect', null);
const cds = flag('--cds', 'cds');
const outRoot = flag('--out', path.join(os.tmpdir(), 'neo2cf-verify'));
const build = !argv.includes('--no-build');

if (!roots.length) {
  process.stderr.write('usage: node checks/verify.js <neo-dir> […] [--expect <cf-dir>] [--cds <path>] [--out <dir>] [--no-build]\n');
  process.exit(2);
}

const repo = path.resolve(import.meta.dirname, '..');
const failures = [];

/** Run a command, print one PASS/FAIL line, and keep going. */
function step(label, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', ...opts });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  // A check that declines to run must not read as one that ran and passed.
  const skipped = opts.skipIfMatch?.test(output);
  const ok = r.status === 0 && !opts.mustNotMatch?.test(output);
  console.log(`  ${skipped ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${label}${skipped ? `   (${output.trim().replace(/^SKIP\s*/, '')})` : ''}`);
  if (skipped) return output;
  if (!ok) {
    failures.push(label);
    process.stdout.write(output.split('\n').slice(-25).map((l) => `        ${l}`).join('\n') + '\n');
  }
  return output;
}

console.log('');
step('tests', process.execPath, ['test/run.js']);

const outs = [];
for (const root of roots) {
  const name = path.basename(root).replace(/[^\w.-]/g, '_');
  const out = path.join(outRoot, name);
  fs.rmSync(out, { recursive: true, force: true });
  outs.push(out);
  // A blocker makes `convert` exit non-zero, which is the point: the sweep is
  // meant to fail when the output is not safe to hand over.
  step(`convert ${name}`, process.execPath, ['bin/neo2cf.js', 'convert', root, '-o', out, '--write']);
}

step('emitted tree — scope, sentinels, re-parse', process.execPath, ['checks/emitted.js', ...outs], {
  // The check reports problems in its output rather than in its exit code.
  mustNotMatch: /[1-9]\d* problems?|[1-9]\d* do not parse/,
});
step('refusal ceilings', process.execPath, ['checks/ceiling.js', ...roots]);
step('$. leaks — every remaining site has a finding', process.execPath, ['checks/leaks.js', ...roots]);
step('cross-file awaits — every async call is awaited', process.execPath, ['checks/awaits.js', ...outs]);
step('procedure names — every CALL resolves to a .hdbprocedure', process.execPath, ['checks/procnames.js', ...outs]);
step('cds compile — the emitted model, through CAP itself', process.execPath, ['checks/cdscompile.js', ...outs], {
  skipIfMatch: /^\s*SKIP\b/,
});
if (expect) step('score', process.execPath, ['bin/neo2cf.js', 'score', roots[0], '--expect', expect]);

if (build) {
  for (const out of outs) {
    // cds build writes gen/ inside the emitted tree, never anywhere else.
    // `cds` is a shell wrapper on Windows, so it needs a shell — and a shell
    // needs the path quoted, because node itself lives under "Program Files".
    step(`cds build --production  ${path.basename(out)}`, `"${cds}" build --production`, [], {
      shell: true,
      cwd: out,
      mustNotMatch: /\berror\b/i,
    });
  }
} else {
  console.log('  SKIP  cds build --production   (--no-build)');
}

console.log('');
if (failures.length) {
  console.log(`  ${failures.length} step(s) failed: ${failures.join(', ')}\n`);
  process.exit(1);
}
console.log(`  everything passed — output in ${outRoot}\n`);
