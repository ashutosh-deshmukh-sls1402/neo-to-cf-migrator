import assert from 'node:assert/strict';
import { classifyFile, classifyFolder, KIND } from '../src/core/artifacts.js';

test('the four convertible kinds', () => {
  assert.equal(classifyFile('X.calculationview').kind, KIND.CALCVIEW);
  assert.equal(classifyFile('X.hdbprocedure').kind, KIND.PROCEDURE);
  assert.equal(classifyFile('X.xsodata').kind, KIND.SERVICE);
  assert.equal(classifyFile('X.xsjslib').kind, KIND.LIBRARY);
  assert.equal(classifyFile('X.xsjs').kind, KIND.LIBRARY);
});

test('excluded types are recognised, not unknown — the distinction matters', () => {
  for (const f of ['X.xsjob', 'X.xsaccess', 'X.xsprivileges', 'X.analyticprivilege', 'X.xshttpdest']) {
    const c = classifyFile(f);
    assert.equal(c.known, true, `${f} should be known`);
    assert.equal(c.convert, false, `${f} should not convert`);
    assert.ok(c.why, `${f} should say why`);
  }
});

test('.hdbtable is excluded — tables come from the live DB', () => {
  const c = classifyFile('T.hdbtable');
  assert.equal(c.known, true);
  assert.equal(c.convert, false);
});

test('an unseen extension is unknown, so it gets reported rather than ignored', () => {
  const c = classifyFile('notes.txt');
  assert.equal(c.known, false);
  assert.equal(c.kind, KIND.UNKNOWN);
});

test('a file with no extension is not reported as an unknown type', () => {
  assert.equal(classifyFile('Makefile').ext, '');
});

test('extension matching is case-insensitive', () => {
  assert.equal(classifyFile('X.XSJSLIB').kind, KIND.LIBRARY);
});

test('a folder holding two kinds reports both — Library/ really does', () => {
  // The corpus has Library folders holding .xsjslib, .xsodata AND .xsjs.
  const c = classifyFolder(['a.xsjslib', 'b.xsodata', 'c.xsjs']);
  assert.deepEqual(c.kinds, ['library', 'service']);
  assert.equal(c.counts.library, 2);
  assert.equal(c.counts.service, 1);
});

test('folder classification counts excluded and unknown separately', () => {
  const c = classifyFolder(['a.calculationview', 'b.xsjob', 'readme.txt']);
  assert.deepEqual(c.kinds, ['calcview']);
  assert.equal(c.excluded, 1);
  assert.deepEqual(c.unknown, ['readme.txt']);
});

test('an empty folder has no kinds', () => {
  assert.deepEqual(classifyFolder([]).kinds, []);
});
