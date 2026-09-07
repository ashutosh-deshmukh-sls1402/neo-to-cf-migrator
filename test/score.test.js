import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { score } from '../score/compare.js';

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo2cf-score-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

const NEO = {
  'MOD/Library/Kept.xsjslib': 'function f() { return 1; }',
  'MOD/Library/Dropped.xsjslib': 'function g() { return 2; }',
  'MOD/Library/Anchor.xsjslib': '$.import("S.MOD", "X");',
};

test('a NEO file the reference never migrated is DROPPED, not a miss', () => {
  const neo = tree(NEO);
  const cf = tree({
    'srv/lib/S/MOD/Library/handlers/Kept.js': '',
    'srv/lib/S/MOD/Library/handlers/Anchor.js': '',
  });
  const r = score(neo, cf, { schema: 'S' });
  const h = r.roles.handler;
  assert.equal(h.exact, 2);
  assert.equal(h.dropped, 1);      // Dropped.js exists nowhere in the reference
  assert.equal(h.sameDir, 0);      // ...and its folder DOES exist, which used to
  assert.equal(h.missing, 0);      //    make it read as a naming-rule failure
});

test('a file the reference put somewhere else is still a real miss', () => {
  const neo = tree(NEO);
  const cf = tree({
    'srv/lib/S/MOD/Library/handlers/Kept.js': '',
    'srv/lib/S/MOD/Library/handlers/Anchor.js': '',
    'srv/lib/S/SOMEWHERE/ELSE/handlers/Dropped.js': '',   // same name, wrong folder
  });
  const r = score(neo, cf, { schema: 'S' });
  const h = r.roles.handler;
  assert.equal(h.dropped, 0, 'the reference has this file, so it was not dropped');
  assert.equal(h.sameDir + h.missing, 1, 'and it still counts against us');
  assert.equal(h.exact, 2);
});

test('a NEO file the run produced nothing for is counted, not silently skipped', () => {
  // The old scorecard predicted a path for every NEO file whether or not the
  // pipeline could produce it, so a library that fails to convert could still
  // score as a hit. It cannot now: it lands in `notEmitted` and in no role's
  // MADE column.
  const neo = tree({
    ...NEO,
    'MOD/Library/Broken.xsjslib': 'function (){',      // does not parse
  });
  const cf = tree({
    'srv/lib/S/MOD/Library/handlers/Kept.js': '',
    'srv/lib/S/MOD/Library/handlers/Anchor.js': '',
    'srv/lib/S/MOD/Library/handlers/Broken.js': '',    // the reference HAS it
  });
  const r = score(neo, cf, { schema: 'S' });
  assert.equal(r.notEmitted.length, 1);
  assert.equal(r.notEmitted[0].path, 'MOD/Library/Broken.xsjslib');
  assert.ok(!r.misses.some((m) => m.predicted.endsWith('Broken.js')), 'never claimed as a hit or a miss');
  assert.equal(r.roles.handler.exact, 2, 'only the two that were actually written');
});
