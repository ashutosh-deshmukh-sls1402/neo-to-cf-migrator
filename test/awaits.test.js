/**
 * Cross-file `await` propagation. The unit here is a set of emitted files,
 * because that is the only level at which the question can be asked.
 */

import assert from 'node:assert/strict';
import { propagateAwaits } from '../src/emit/awaits.js';

const file = (p, text, role = 'handler') => ({ path: p, text, role });
const textOf = (files, p) => files.find((f) => f.path === p).text;

test('a call to an async function in another file gets its await', () => {
  const files = [
    file('srv/lib/A/lib.js', 'export async function load(x) { return x; }\n'),
    file('srv/lib/A/use.js', "import { load } from './lib.js';\nfunction go() { var r = load(1); return r; }\n"),
  ];
  const r = propagateAwaits(files);
  assert.equal(r.awaited, 1);
  assert.match(textOf(files, 'srv/lib/A/use.js'), /var r = await load\(1\)/);
  // and the function holding it is now async, or the await would not parse
  assert.match(textOf(files, 'srv/lib/A/use.js'), /async function go/);
  assert.equal(r.asyncified, 1);
});

test('it reaches through a default import, which is what an .xsjslib becomes', () => {
  const files = [
    file('srv/lib/A/lib.js', 'async function load(x) { return x; }\nexport default { load };\n'),
    file('srv/lib/A/use.js', "import lib from './lib.js';\nasync function go() { return lib.load(1); }\n"),
  ];
  propagateAwaits(files);
  // A `return` of a Promise from an async function is already correct, so this
  // one is left exactly as it was.
  assert.match(textOf(files, 'srv/lib/A/use.js'), /return await lib\.load\(1\)|return lib\.load\(1\)/);
});

test('the fixed point runs the whole way up the chain, across three files', () => {
  const files = [
    file('srv/lib/a.js', 'export async function bottom() { return 1; }\n'),
    file('srv/lib/b.js', "import { bottom } from './a.js';\nexport function middle() { return bottom(); }\n"),
    file('srv/lib/c.js', "import { middle } from './b.js';\nfunction top() { var x = middle(); return x; }\n"),
  ];
  const r = propagateAwaits(files);
  assert.match(textOf(files, 'srv/lib/c.js'), /var x = await middle\(\)/);
  assert.match(textOf(files, 'srv/lib/c.js'), /async function top/);
  assert.equal(r.asyncified, 2, 'middle and top');
});

test('an await that would bind wrong gets its parentheses', () => {
  const files = [
    file('srv/lib/a.js', 'export async function rows() { return []; }\n'),
    file('srv/lib/b.js', "import { rows } from './a.js';\nasync function go() { return rows().length; }\n"),
  ];
  propagateAwaits(files);
  assert.match(textOf(files, 'srv/lib/b.js'), /\(await rows\(\)\)\.length/);
});

test('a Promise the code is deliberately holding is left alone', () => {
  const files = [
    file('srv/lib/a.js', 'export async function go() { return 1; }\n'),
    file('srv/lib/b.js', "import { go } from './a.js';\nfunction run() { go().then(done); }\n"),
  ];
  const r = propagateAwaits(files);
  assert.equal(r.awaited, 0);
  assert.match(textOf(files, 'srv/lib/b.js'), /go\(\)\.then\(done\)/);
});

test('a call at module top level is not given an await', () => {
  // It would need top-level await, which changes when the module finishes
  // loading. Not a decision to make silently.
  const files = [
    file('srv/lib/a.js', 'export async function go() { return 1; }\n'),
    file('srv/lib/b.js', "import { go } from './a.js';\nvar x = go();\n"),
  ];
  const r = propagateAwaits(files);
  assert.equal(r.awaited, 0);
});

test('an import that resolves to nothing we emitted is left alone', () => {
  const files = [
    file('srv/lib/b.js', "import { go } from './missing.js';\nfunction run() { go(); }\n"),
  ];
  const r = propagateAwaits(files);
  assert.equal(r.awaited, 0);
  assert.match(textOf(files, 'srv/lib/b.js'), /\n  ?go\(\);|\{ go\(\); \}/);
});

test('a file that does not parse is skipped, not mangled', () => {
  const files = [
    file('srv/lib/a.js', 'export async function go() { return 1; }\n'),
    file('srv/lib/bad.js', 'function ( {\n'),
  ];
  const r = propagateAwaits(files);
  assert.deepEqual(r.skipped, ['srv/lib/bad.js']);
  assert.equal(textOf(files, 'srv/lib/bad.js'), 'function ( {\n');
});

test('a synchronous call graph is not touched at all', () => {
  const files = [
    file('srv/lib/a.js', 'export function go() { return 1; }\n'),
    file('srv/lib/b.js', "import { go } from './a.js';\nfunction run() { return go(); }\n"),
  ];
  const r = propagateAwaits(files);
  assert.equal(r.awaited, 0);
  assert.equal(r.asyncified, 0);
  assert.match(textOf(files, 'srv/lib/b.js'), /^function run/m);
});
