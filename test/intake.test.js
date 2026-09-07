import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discover } from '../src/core/intake.js';

/** Build a throwaway NEO-shaped tree. */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo2cf-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body ?? '');
  }
  return root;
}

const TREE = {
  // an app: no convertible files of its own, artifacts further down
  'JOB_BIDDING/COMMON_View/Views/A.calculationview': '',
  'JOB_BIDDING/COMMON_View/Procedures/P.hdbprocedure': '',
  'JOB_BIDDING/COMMON_View/Library/L.xsjslib': '$.import("TECK.Env_Config", "CommonUtil");',
  'JOB_BIDDING/COMMON_View/Services/S.xsodata': '',
  'JOB_BIDDING/COMMON_View/Services/E.xsjs': '$.import("TECK.Inbound", "Common_util");',
  // a top-level package that is NOT an app: convertible files directly inside
  'Env_Config/CommonUtil.xsjslib': '$.import("TECK.Env_Config", "Other");',
  // out of scope
  'JOB_BIDDING/COMMON_View/Services/S.xsaccess': '',
  'xsjob_Notification/N.xsjob': '',
  // unrecognised
  'README.md': '',
};

test('discover finds every convertible file and nothing else', () => {
  const r = discover(fixture(TREE));
  assert.equal(r.counts.calcview, 1);
  assert.equal(r.counts.procedure, 1);
  assert.equal(r.counts.service, 1);
  assert.equal(r.counts.library, 3); // 2 xsjslib + 1 xsjs
  assert.equal(r.totals.convertible, 6);
});

test('schema is inferred from $.import, which is the only place it appears', () => {
  const r = discover(fixture(TREE));
  assert.equal(r.schema, 'TECK');
  assert.equal(r.schemaInferred, true);
});

test('an explicit schema wins over inference', () => {
  const r = discover(fixture(TREE), { schema: 'OVERRIDE' });
  assert.equal(r.schema, 'OVERRIDE');
  assert.equal(r.schemaInferred, false);
});

test('app inference: nested-only folders are apps, folders with own files are not', () => {
  const r = discover(fixture(TREE));
  assert.deepEqual(r.apps, ['JOB_BIDDING']);
  assert.ok(!r.apps.includes('Env_Config'));
  assert.ok(!r.apps.includes('xsjob_Notification'));
});

test('a folder holding two kinds produces two units, not one mislabelled one', () => {
  const r = discover(fixture(TREE));
  const services = r.units.filter((u) => u.neoDir === 'JOB_BIDDING/COMMON_View/Services');
  assert.deepEqual(services.map((u) => u.kind).sort(), ['library', 'service']);
});

test('excluded files are recorded with a reason, not dropped', () => {
  const r = discover(fixture(TREE));
  assert.equal(r.totals.excluded, 2);
  for (const f of r.excludedFiles) assert.ok(f.why, `${f.path} needs a reason`);
});

test('unrecognised files are surfaced so nothing vanishes silently', () => {
  const r = discover(fixture(TREE));
  assert.deepEqual(r.unknownFiles, ['README.md']);
});

test('sections group sibling artifact folders under one parent', () => {
  const r = discover(fixture(TREE));
  const common = r.sections.find((s) => s.path === 'JOB_BIDDING/COMMON_View');
  assert.ok(common);
  assert.deepEqual(
    [...new Set(common.units.map((u) => u.kind))].sort(),
    ['calcview', 'library', 'procedure', 'service'],
  );
});

test('node_modules and .git are never walked', () => {
  const root = fixture({ ...TREE, 'node_modules/pkg/x.xsjslib': '', '.git/y.xsjs': '' });
  const r = discover(root);
  assert.equal(r.counts.library, 3);
});

test('a missing root fails loudly', () => {
  assert.throws(() => discover(path.join(os.tmpdir(), 'neo2cf-does-not-exist')), /Not a folder/);
});

test('one app candidate is inferred; several is reported, never guessed', () => {
  // TECK-shaped: exactly one nested-only top-level folder -> safe to infer.
  const one = discover(fixture(TREE));
  assert.deepEqual(one.apps, ['JOB_BIDDING']);
  assert.equal(one.warnings.filter((w) => w.code === 'APP_AMBIGUOUS').length, 0);

  // ICBC-shaped: several top-level modules and no app wrapper. Dropping all of
  // them from db/ paths would collide DSM/Views with TLW/Views.
  const many = discover(
    fixture({
      'DSM/Views/A.calculationview': '',
      'TLW/Views/B.calculationview': '',
      'JBD/Views/C.calculationview': '',
      'Common/L.xsjslib': '$.import("ICBC.Common", "X");',
    }),
  );
  assert.deepEqual(many.apps, [], 'must not guess');
  const w = many.warnings.find((x) => x.code === 'APP_AMBIGUOUS');
  assert.ok(w, 'should warn');
  assert.deepEqual(w.candidates, ['DSM', 'JBD', 'TLW']);
  assert.ok(w.fix.includes('--app'));
});

test('imports into another schema are reported as cross-container references', () => {
  const r = discover(
    fixture({
      'A/L.xsjslib': '$.import("ICBC.Common","X");$.import("ICBC.Other","Y");$.import("COEDM.Far","Z");',
    }),
  );
  assert.equal(r.schema, 'ICBC');
  const w = r.warnings.find((x) => x.code === 'FOREIGN_SCHEMA_IMPORTS');
  assert.ok(w);
  assert.ok(w.message.includes('COEDM'));
});

test('a tree with no imports reports the schema as unknown rather than defaulting', () => {
  const r = discover(fixture({ 'X/V.calculationview': '' }));
  assert.equal(r.schema, null);
  assert.ok(r.warnings.some((w) => w.code === 'SCHEMA_UNKNOWN'));
});

test('two .xsodata in one folder is reported — they share one service.cds', () => {
  // Real: TECK has two such folders. Without this the second silently wins.
  const r = discover(
    fixture({
      'A/M/Services/One.xsodata': '',
      'A/M/Services/Two.xsodata': '',
      'A/M/Library/L.xsjslib': '$.import("S.A", "X");',
    }),
  );
  const w = r.warnings.find((x) => x.code === 'SERVICE_SHARED_FOLDER');
  assert.ok(w, 'should warn');
  assert.equal(w.neoDir, 'A/M/Services');
  assert.deepEqual(w.files, ['One.xsodata', 'Two.xsodata']);
});

test('a single .xsodata per folder does not warn', () => {
  const r = discover(fixture({ 'A/M/Services/One.xsodata': '', 'A/L.xsjslib': '$.import("S.A","X");' }));
  assert.equal(r.warnings.filter((w) => w.code === 'SERVICE_SHARED_FOLDER').length, 0);
});
