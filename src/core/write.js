/**
 * Writing the output tree.
 *
 * Dry-run is the default everywhere; this is only called when the caller has
 * explicitly asked. Two guards, both enforced here rather than trusted:
 *
 *   1. The output directory may never be inside the NEO tree. NEO is an input,
 *      and both knowledge bases say never to modify it.
 *   2. A blocker stops the write unless it is explicitly overridden, because a
 *      partially-converted tree that looks complete is worse than none.
 */

import fs from 'node:fs';
import path from 'node:path';

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** True when `child` is inside `parent` (or is the same directory). */
export function isInside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + path.sep.toLowerCase()) || c.startsWith(p + '/');
}

/**
 * @param {{path:string,text:string}[]} files
 * @param {string} outDir
 * @param {string} neoRoot
 * @param {{force?:boolean, blockers?:number}} [opts]
 * @returns {{written:number, skipped:number, bytes:number}}
 */
export function writeFiles(files, outDir, neoRoot, opts = {}) {
  if (isInside(outDir, neoRoot)) {
    throw new Error(
      `Refusing to write into the NEO tree.\n` +
        `  NEO source : ${path.resolve(neoRoot)}\n` +
        `  output dir : ${path.resolve(outDir)}\n` +
        `NEO is an input and is never modified. Choose an output directory outside it.`,
    );
  }

  if (opts.blockers && !opts.force) {
    throw new Error(
      `${opts.blockers} blocker(s) outstanding — nothing was written.\n` +
        `Read them first; pass --force to write anyway, knowing the output is incomplete.`,
    );
  }

  let written = 0;
  let bytes = 0;
  for (const f of files) {
    const abs = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.text, 'utf8');
    written++;
    bytes += Buffer.byteLength(f.text, 'utf8');
  }
  return { written, skipped: 0, bytes };
}
