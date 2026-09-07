/**
 * Test runner. No framework — node:assert and a counter.
 *
 *   node test/run.js            all
 *   node test/run.js naming     only files whose name contains "naming"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

let passed = 0;
const failures = [];

globalThis.test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, err });
  }
};

const files = fs
  .readdirSync(here)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

for (const f of files) {
  await import(pathToFileURL(path.join(here, f)).href);
}

for (const { name, err } of failures) {
  console.error(`\n  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
}

console.log(
  `\n  ${passed} passed, ${failures.length} failed  (${files.length} file${files.length === 1 ? '' : 's'})\n`,
);
process.exit(failures.length ? 1 : 0);
