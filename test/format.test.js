import assert from 'node:assert/strict';
import { formatJs } from '../src/emit/format.js';

test('formatJs rewrites .js and leaves everything else alone', async () => {
  const files = [
    { path: 'srv/lib/S/h.js', text: 'function f(a){\n\t\treturn   a+1\n}\n' },
    { path: 'db/cds/schema.cds', text: 'entity  E  { key ID : Integer }\n' },
  ];
  const r = await formatJs(files);
  assert.equal(r.formatted, 1);
  assert.deepEqual(r.failed, []);
  assert.equal(files[0].text, 'function f(a) {\n  return a + 1;\n}\n');
  assert.equal(files[1].text, 'entity  E  { key ID : Integer }\n', '.cds is not ours to format');
});

test('a file Prettier cannot parse is kept exactly as it was, and reported', async () => {
  const files = [{ path: 'srv/lib/S/broken.js', text: 'function f( {\n' }];
  const before = files[0].text;
  const r = await formatJs(files);
  assert.equal(r.formatted, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].file, 'srv/lib/S/broken.js');
  assert.equal(files[0].text, before);
});
