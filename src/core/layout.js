/**
 * NEO path -> CF path.
 *
 * Verified against the TECK pair (SESSION-CONTEXT.md §7). The two asymmetries
 * that are easy to get wrong:
 *
 *   db/src and db/cds  DROP the <APP> segment
 *   srv/lib            KEEPS it, under srv/lib/<SCHEMA>/
 *
 * Evidence for the srv rule, from the shipped CF code: a handler at
 * srv/lib/TECK/JOB_BIDDING/JB_HR/JB_EMPPROFILE/Library/handlers/ imports
 * Env_Config's CommonUtil as "../../../../../Env_Config/handlers/CommonUtil.js"
 * — five levels up lands on srv/lib/TECK, so Env_Config sits directly under the
 * schema while JOB_BIDDING keeps its full nesting.
 */

import path from 'node:path';
import { KIND } from './artifacts.js';

const posix = (p) => p.split(path.sep).join('/');

/**
 * Join path segments, dropping the empty ones.
 *
 * `path.dirname` returns "." for a file at the root of the NEO tree, and TECK
 * has four `.xsjs` sitting there — which produced `srv/lib/TECK/./handlers/`.
 */
const join = (...segs) => segs.filter((s) => s && s !== '.').join('/');

/** Strip the leading <APP> segment, if this path is under it. */
function withoutApp(relDir, app) {
  if (!app) return relDir;
  const segs = relDir.split('/').filter(Boolean);
  if (segs[0] === app) segs.shift();
  return segs.join('/');
}

/**
 * Where a calc view's CDS proxy lands.
 *
 * One file per view mirrors the NEO tree and is the default. Bundling collapses
 * them — the entity names already carry their container, so nothing collides
 * when they share a file.
 */
function cdsPath(bundle, dbDir, entityName) {
  if (bundle === 'all') return 'db/cds/schema.cds';
  if (bundle === 'module') {
    // The module is the top folder of the db path — HRS, INC, MTG. A view at
    // the root of the tree has none, so it falls back to the shared file.
    const mod = dbDir.split('/').filter(Boolean)[0];
    return mod ? `db/cds/${mod}/${mod}_schema.cds` : 'db/cds/schema.cds';
  }
  return join('db/cds', dbDir, `${entityName}.cds`);
}

/**
 * @param {object} args
 * @param {string} args.relPath  file path relative to the NEO root, posix-style
 * @param {string} args.kind     from artifacts.js
 * @param {string} args.schema   e.g. "TECK"
 * @param {string|null} args.app e.g. "JOB_BIDDING", or null if none
 * @param {string} [args.entityName] flattened entity name, for the cds proxy
 * @param {string|null} [args.cdsBundle] null | 'all' | 'module' — see cdsPath
 * @param {boolean} [args.genericServiceNames] true: KIND.SERVICE always emits
 *   service.cds/service.js. false (default): named after the .xsodata itself.
 * @returns {{path:string, role:string}[]} every file this NEO file becomes
 */
export function targetsFor({ relPath, kind, schema, app, entityName, cdsBundle, genericServiceNames }) {
  const dir = posix(path.dirname(relPath));
  const base = path.basename(relPath);
  const stem = base.slice(0, base.lastIndexOf('.'));

  switch (kind) {
    case KIND.CALCVIEW: {
      const dbDir = withoutApp(dir, app);
      return [
        { path: join('db/src', dbDir, `${stem}.hdbcalculationview`), role: 'calcview' },
        { path: join('db/src', dbDir, `TABLE_FUNCTION_${stem}.hdbfunction`), role: 'tablefunction' },
        { path: cdsPath(cdsBundle, dbDir, entityName || stem), role: 'cdsproxy' },
      ];
    }

    case KIND.PROCEDURE:
      // Procedures keep their native form and get no CDS proxy — they are
      // reached from JS via cds.run('CALL ...').
      return [{ path: join('db/src', withoutApp(dir, app), base), role: 'procedure' }];

    case KIND.SERVICE: {
      // One .xsodata becomes a .cds + .js pair, in place. Named after the
      // .xsodata itself by default — two endpoints in sibling folders are then
      // two differently-named files, not two files both called `service.cds`
      // that only their path tells apart. `genericServiceNames` reverts to
      // that generic name for a project that would rather have it.
      const base = genericServiceNames ? 'service' : stem;
      return [
        { path: join(`srv/lib/${schema}`, dir, `${base}.cds`), role: 'servicecds' },
        { path: join(`srv/lib/${schema}`, dir, `${base}.js`), role: 'servicejs' },
      ];
    }

    case KIND.LIBRARY:
      // .xsjs and .xsjslib both become one handler file, mirroring the NEO path
      // with `handlers/` appended. Confirmed: 57 of TECK's 63 shipped handlers
      // land on exactly this path, and none of ours land in the wrong folder.
      return [{ path: join(`srv/lib/${schema}`, dir, 'handlers', `${stem}.js`), role: 'handler' }];

    default:
      return [];
  }
}

/**
 * Relative import specifier between two emitted files, as ESM wants it:
 * always explicit, always with the extension, always './' or '../' prefixed.
 */
export function importSpecifier(fromFile, toFile) {
  let rel = posix(path.relative(path.dirname(fromFile), toFile));
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}
