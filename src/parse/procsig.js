/**
 * Procedure signatures, read from the `.hdbprocedure` files themselves.
 *
 * This exists because of a refusal that turned out not to be a defect. 116 of
 * the 117 statements blocked by BIND_COUNT_MISMATCH are `prepareCall`s whose
 * SQL has more `?` than the code binds:
 *
 *     cstmt = conn.prepareCall('CALL "…::TECK_prCreateSummary"(?,?,?,?,?)');
 *     cstmt.setInteger(1, …); … cstmt.setNString(4, …);   // only four
 *     cstmt.execute();
 *     SUMID = cstmt.getInteger(5);                        // the fifth is read back
 *
 * The fifth `?` is an OUT parameter — normal CallableStatement usage, not a bug.
 * The procedure declares it:
 *
 *     PROCEDURE "…::TECK_prCreateSummary"
 *     ( IN JOBID BIGINT, …, OUT OPK_BDSID BIGINT )
 *
 * and the hand-migrated CF reads it back **by name** (`result.OPK_BDSID`), which
 * is the one thing the JavaScript alone cannot tell us. So the signature has to
 * be read from the procedure, and the NEO tree has it.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Comments would otherwise be split on by the parameter scanner. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** Split on commas that are not inside parentheses or quotes — `NVARCHAR(30)`. */
function splitParams(text) {
  const out = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}

/**
 * `PROCEDURE <name> ( … )` → `{ name, params: [{ mode, name, table }] }`.
 *
 * Returns null when the header cannot be read, which is the honest answer: a
 * half-read signature would map an OUT parameter to the wrong name, and that is
 * worse than refusing the statement.
 */
export function parseProcedureSignature(text) {
  const src = stripComments(text);
  const m = /\bPROCEDURE\s+((?:"(?:[^"]|"")*"|[\w#$]+)(?:\s*\.\s*(?:"(?:[^"]|"")*"|[\w#$]+))*)\s*\(/i.exec(src);
  if (!m) return null;

  let depth = 1, i = m.index + m[0].length;
  const start = i;
  for (; i < src.length && depth; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
  }
  if (depth) return null;

  const params = [];
  for (const raw of splitParams(src.slice(start, i - 1))) {
    const t = raw.trim();
    if (!t) continue;                      // `PROCEDURE p ()` — no parameters
    // HANA defaults an unmarked parameter to IN, and the corpus writes the mode
    // in either case. The type is required: without it this is not a parameter
    // list we understand.
    const q = /^(?:(IN|OUT|INOUT)\s+)?("(?:[^"]|"")*"|[\w#$]+)\s+(\S)/i.exec(t);
    if (!q) return null;
    params.push({
      mode: (q[1] || 'IN').toUpperCase(),
      name: q[2].replace(/^"|"$/g, '').toUpperCase(),
      table: /\bTABLE\s*\(/i.test(t),
    });
  }

  // `"S"."S.PKG::p"` — the schema is a separate quoted part, and the dots
  // inside the second one are the package path, not a separator.
  const parts = m[1].match(/"(?:[^"]|"")*"|[\w#$]+/g) || [];
  const name = (parts[parts.length - 1] || '').replace(/^"|"$/g, '');
  return { name, params };
}

/** `Admin.Procedures::prCreateFieldManagement` → `ADMIN.PROCEDURES::PRCREATEFIELDMANAGEMENT` */
const norm = (s) => s.replace(/^"|"$/g, '').toUpperCase();

/**
 * Index every `.hdbprocedure` in a NEO tree by the path a `CALL` names it with.
 *
 * Keyed on the *file location* rather than the declared name: the declaration is
 * inconsistent across the corpus (some already flattened, some schema-qualified)
 * while the path a caller writes always mirrors the folders. A bare basename key
 * is kept as a fallback, and dropped when two procedures share it with different
 * signatures — a wrong signature is worse than no signature.
 */
export function procedureIndex(root, rels) {
  const byPath = new Map();
  const byName = new Map();
  const clashed = new Set();

  for (const rel of rels) {
    let sig;
    try { sig = parseProcedureSignature(fs.readFileSync(path.join(root, rel), 'utf8')); }
    catch { continue; }
    if (!sig) continue;

    const posix = rel.split(path.sep).join('/');
    const base = posix.slice(posix.lastIndexOf('/') + 1).replace(/\.\w+$/, '');
    const dir = posix.slice(0, posix.lastIndexOf('/'));
    byPath.set(norm(`${dir.split('/').join('.')}::${base}`), sig);

    const key = norm(base);
    if (byName.has(key) && JSON.stringify(byName.get(key).params) !== JSON.stringify(sig.params)) clashed.add(key);
    byName.set(key, sig);
  }
  for (const k of clashed) byName.delete(k);

  return { byPath, byName };
}

/** The same index, built from an intake so every command spells it one way. */
export function indexFromIntake(root, intake) {
  const rels = [];
  for (const u of intake.units) {
    for (const f of u.files) {
      if (/\.hdbprocedure$/i.test(f)) rels.push([u.neoDir, f].filter(Boolean).join('/'));
    }
  }
  return procedureIndex(root, rels);
}

/**
 * The signature a `CALL` statement names, or null.
 *
 * Accepts every spelling in the corpus: `CALL "S"."S.PKG::p"(…)`,
 * `CALL "S.PKG::p"(…)`, `CALL"S.PKG::p"(…)` and an unquoted `CALL p(…)`.
 */
export function lookupProcedure(index, sql, schema) {
  if (!index) return null;
  const m = /\bCALL\s*(?:"([^"]+)"\s*\.\s*)?("[^"]+"|[\w#$.:]+)\s*\(/i.exec(sql);
  if (!m) return null;

  let full = norm(m[2]);
  const prefix = schema ? `${norm(schema)}.` : null;
  if (prefix && full.startsWith(prefix)) full = full.slice(prefix.length);

  return index.byPath.get(full) || index.byName.get(full.split('::').pop().split('.').pop()) || null;
}
