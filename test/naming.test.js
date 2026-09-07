import assert from 'node:assert/strict';
import {
  flattenEntityName,
  flattenCallPath,
  startsWithDigit,
  renameNumericLeading,
  RenameRegistry,
} from '../src/core/naming.js';

test('flattenEntityName: the verified TECK example', () => {
  assert.equal(
    flattenEntityName('TECK.JOB_BIDDING.JB_ADMIN_CONSOLE.Views::TECK_M_getSUPList'),
    'TECK_JOB_BIDDING_JB_ADMIN_CONSOLE_VIEWS_TECK_M_GETSUPLIST',
  );
});

test('flattenEntityName: mixed-case object names lose their casing', () => {
  assert.equal(flattenEntityName('a.b::getSUPList'), 'A_B_GETSUPLIST');
});

test('flattenCallPath: same flattening, case preserved, no quotes', () => {
  // Checklist item 13 — HANA resolves the unquoted name case-insensitively.
  assert.equal(
    flattenCallPath('TECK.JOB_BIDDING.COMMON_View.Procedures::TECK_prCreateAuditLog'),
    'TECK_JOB_BIDDING_COMMON_View_Procedures_TECK_prCreateAuditLog',
  );
});

test('startsWithDigit', () => {
  assert.equal(startsWithDigit('91Efu5zcsYvGmdP'), true);
  assert.equal(startsWithDigit('yuEfu5zcsYvGmdP'), false);
  assert.equal(startsWithDigit('_x'), false);
});

test('renameNumericLeading keeps the tail intact so the mapping stays traceable', () => {
  assert.equal(renameNumericLeading('9UPBK9QDitgIuOp'), 'E9UPBK9QDitgIuOp');
  assert.equal(renameNumericLeading('91Efu5zcsYvGmdP'), 'E91Efu5zcsYvGmdP');
});

test('renameNumericLeading leaves valid identifiers alone', () => {
  assert.equal(renameNumericLeading('alreadyFine'), 'alreadyFine');
});

test('registry: the same NEO alias maps to ONE CF name everywhere', () => {
  // The reference project renamed by hand and gave the same alias two different
  // names in two modules. That is the bug this registry exists to prevent.
  const r = new RenameRegistry();
  const a = r.resolve('9UPBK9QDitgIuOp', 'COMMON/service.cds');
  const b = r.resolve('9UPBK9QDitgIuOp', 'JB_HR/service.cds');
  assert.equal(a.name, b.name);
  assert.equal(r.table().length, 1);
  assert.deepEqual(r.table()[0].sites, ['COMMON/service.cds', 'JB_HR/service.cds']);
});

test('registry: a rename that would collide is pushed until it is free', () => {
  const r = new RenameRegistry();
  r.reserve('E9ABC');
  const out = r.resolve('9ABC', 'x');
  assert.equal(out.collision, 'E9ABC');
  assert.equal(out.name, 'EE9ABC');
});

test('registry: non-renamed names are still reserved, so later renames avoid them', () => {
  const r = new RenameRegistry();
  r.resolve('E9ABC', 'x');
  assert.equal(r.resolve('9ABC', 'y').name, 'EE9ABC');
});

test('registry: table is sorted and reports every rename for the UI team', () => {
  const r = new RenameRegistry();
  r.resolve('9zzz', 'a');
  r.resolve('91aaa', 'b');
  r.resolve('plain', 'c');
  assert.deepEqual(r.table().map((x) => x.from), ['91aaa', '9zzz']);
});
