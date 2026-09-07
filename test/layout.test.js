import assert from 'node:assert/strict';
import { targetsFor, importSpecifier } from '../src/core/layout.js';
import { KIND } from '../src/core/artifacts.js';

const paths = (t) => t.map((x) => x.path);

test('calcview becomes exactly three files, and db/ drops the <APP>', () => {
  const t = targetsFor({
    relPath: 'JOB_BIDDING/COMMON_View/Views/TECK_JB_Clob.calculationview',
    kind: KIND.CALCVIEW,
    schema: 'TECK',
    app: 'JOB_BIDDING',
    entityName: 'VIEWS_TECK_JB_CLOB',
  });
  assert.deepEqual(paths(t), [
    'db/src/COMMON_View/Views/TECK_JB_Clob.hdbcalculationview',
    'db/src/COMMON_View/Views/TABLE_FUNCTION_TECK_JB_Clob.hdbfunction',
    'db/cds/COMMON_View/Views/VIEWS_TECK_JB_CLOB.cds',
  ]);
});

test('procedure keeps its native form and gets no cds proxy', () => {
  const t = targetsFor({
    relPath: 'JOB_BIDDING/JB_HR/JB_CRTJBPSTNG/Procedures/p.hdbprocedure',
    kind: KIND.PROCEDURE,
    schema: 'TECK',
    app: 'JOB_BIDDING',
  });
  assert.deepEqual(paths(t), ['db/src/JB_HR/JB_CRTJBPSTNG/Procedures/p.hdbprocedure']);
});

test('srv/lib KEEPS the <APP> — the asymmetry with db/', () => {
  const t = targetsFor({
    relPath: 'JOB_BIDDING/JB_HR/JB_EMPPROFILE/Library/TECK_HR_Notes.xsjslib',
    kind: KIND.LIBRARY,
    schema: 'TECK',
    app: 'JOB_BIDDING',
  });
  assert.deepEqual(paths(t), [
    'srv/lib/TECK/JOB_BIDDING/JB_HR/JB_EMPPROFILE/Library/handlers/TECK_HR_Notes.js',
  ]);
});

test('.xsjs becomes its own handler, mirroring the NEO path (35 of 60 confirmed)', () => {
  const t = targetsFor({
    relPath: 'JOB_BIDDING/COMMON_View/Services/RecordUnlock.xsjs',
    kind: KIND.LIBRARY,
    schema: 'TECK',
    app: 'JOB_BIDDING',
  });
  assert.deepEqual(paths(t), [
    'srv/lib/TECK/JOB_BIDDING/COMMON_View/Services/handlers/RecordUnlock.js',
  ]);
});

test('a top-level non-app package sits directly under the schema', () => {
  // Verified by the shipped import "../../../../../Env_Config/handlers/CommonUtil.js"
  const t = targetsFor({
    relPath: 'Env_Config/CommonUtil.xsjslib',
    kind: KIND.LIBRARY,
    schema: 'TECK',
    app: 'JOB_BIDDING',
  });
  assert.deepEqual(paths(t), ['srv/lib/TECK/Env_Config/handlers/CommonUtil.js']);
});

test('.xsodata becomes the service.cds + service.js pair, in place', () => {
  const t = targetsFor({
    relPath: 'JOB_BIDDING/JB_HR/JB_CRTJBPSTNG/Services/HR.xsodata',
    kind: KIND.SERVICE,
    schema: 'TECK',
    app: 'JOB_BIDDING',
  });
  assert.deepEqual(paths(t), [
    'srv/lib/TECK/JOB_BIDDING/JB_HR/JB_CRTJBPSTNG/Services/service.cds',
    'srv/lib/TECK/JOB_BIDDING/JB_HR/JB_CRTJBPSTNG/Services/service.js',
  ]);
});

test('no app configured means nothing is dropped from db/', () => {
  const t = targetsFor({
    relPath: 'COMMON_View/Views/X.calculationview',
    kind: KIND.CALCVIEW,
    schema: 'S',
    app: null,
    entityName: 'X',
  });
  assert.equal(t[0].path, 'db/src/COMMON_View/Views/X.hdbcalculationview');
});

test('importSpecifier reproduces the real shipped relative import', () => {
  // The shipped handler imports Env_Config's CommonUtil with exactly this path.
  assert.equal(
    importSpecifier(
      'srv/lib/TECK/JOB_BIDDING/JB_HR/JB_EMPPROFILE/Library/handlers/TECK_HR_Notes.js',
      'srv/lib/TECK/Env_Config/handlers/CommonUtil.js',
    ),
    '../../../../../Env_Config/handlers/CommonUtil.js',
  );
});

test('importSpecifier prefixes ./ for a sibling', () => {
  assert.equal(importSpecifier('a/b/x.js', 'a/b/y.js'), './y.js');
});

test('a file at the root of the NEO tree gets no "." segment in its target path', () => {
  // TECK keeps four .xsjs at the top of the tree, where path.dirname() is ".".
  const t = targetsFor({ relPath: 'GetTableData.xsjs', kind: KIND.LIBRARY, schema: 'TECK', app: null });
  assert.equal(t[0].path, 'srv/lib/TECK/handlers/GetTableData.js');

  const p = targetsFor({ relPath: 'Thing.hdbprocedure', kind: KIND.PROCEDURE, schema: 'TECK', app: null });
  assert.equal(p[0].path, 'db/src/Thing.hdbprocedure');

  const s = targetsFor({ relPath: 'Svc.xsodata', kind: KIND.SERVICE, schema: 'TECK', app: null });
  assert.equal(s[0].path, 'srv/lib/TECK/service.cds');
});
