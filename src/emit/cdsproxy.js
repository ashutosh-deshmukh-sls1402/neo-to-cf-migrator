/**
 * PORTED from migration-cleanup-toolkit/src/generator/cdsproxy.js (CJS -> ESM).
 * Type map and layout validated against 167 hand-authored proxies (92.8% column+type
 * reproduction). Do not retune without re-running score.
 */
/**
 * CDS proxy authoring — the CAP-side entity that exposes a deployed calculation view.
 *
 * The drop routinely ships fewer proxies than views (observed 7:6, 1:0, 23:18), and a
 * view with no proxy cannot be projected by a service. Nothing reconstructed them until
 * now, though the shape is entirely derivable: a proxy's columns are the calc view's
 * `viewAttributes` — the very same list that becomes the table function's
 * `RETURNS TABLE`. One source, two renderings.
 *
 * ── The type mapping is measured, not assumed ───────────────────────────────
 * Derived by correlating 167 hand-authored proxies against their NEO views, 675 columns
 * in total:
 *
 *     NVARCHAR(n)   -> String(n)     483 / 489
 *     INTEGER       -> Integer       141 / 142
 *     BIGINT        -> Integer64      14 / 14
 *     CLOB          -> hana.CLOB      13 / 13
 *     DECIMAL(p,s)  -> Decimal(p, s)   9 / 9
 *     SMALLINT      -> Int16           5 / 8   (3 hand-written as hana.SMALLINT)
 *
 * `Integer16` was the mapping here until the emitted model was put through the
 * CDS compiler: there is no such type, and every SMALLINT column failed with
 * `No artifact has been found with name "Integer16"` — 64 of them in one corpus.
 * The CDS name is `Int16`. Nothing caught it before because the type only had to
 * look right, and it did.
 *
 * DATE, VARCHAR, DOUBLE and TIMESTAMP occur in NEO (18 / 12 / 7 / 1 columns) but never
 * in a shipped proxy, so their mapping is CAP's documented HANA equivalence rather than
 * observed precedent. They are marked as such in the config so the distinction survives.
 *
 * NCLOB was the third kind of entry, and the one that bit: neither observed nor
 * documented, but assumed by symmetry with CLOB -> hana.CLOB. There is no
 * `cds.hana.NCLOB`, and the compiler says so — `Artifact "cds.hana.NCLOB" has
 * not been found` — exactly as it once did for the invented `Integer16`. The
 * CDS type for an NCLOB column is `LargeString`, which CAP compiles back to
 * NCLOB on HANA, so the deployed column is unchanged. Twice now a type has only
 * had to *look* right to get in here; `test/cdsproxy.test.js` now checks every
 * value in this map against the list `@sap/cds-compiler` actually accepts.
 */

import { cdsIdent } from '../core/naming.js';

/** HANA datatype -> CDS type. Overridable via `cdsProxy.typeMap` in project config. */
const DEFAULT_TYPE_MAP = Object.freeze({
  NVARCHAR: 'String',
  VARCHAR: 'String',
  CLOB: 'hana.CLOB',
  NCLOB: 'LargeString',
  INTEGER: 'Integer',
  BIGINT: 'Integer64',
  SMALLINT: 'Int16',
  TINYINT: 'hana.TINYINT',
  DECIMAL: 'Decimal',
  DOUBLE: 'Double',
  REAL: 'Double',
  DATE: 'Date',
  TIME: 'Time',
  TIMESTAMP: 'Timestamp',
  SECONDDATE: 'Timestamp',
  BOOLEAN: 'Boolean',
});

/** Types that never carry a length, even when NEO records one. */
const NO_LENGTH = new Set(['Integer', 'Integer64', 'Int16', 'Double', 'Date', 'Time', 'Timestamp', 'Boolean', 'LargeString', 'hana.CLOB', 'hana.TINYINT']);

/**
 * Render one HANA attribute as a CDS type.
 * @returns {{type:string, warning:(string|null)}}
 */
function cdsType(attr, typeMap = DEFAULT_TYPE_MAP) {
  const hana = String(attr.datatype || '').toUpperCase();
  const mapped = typeMap[hana];
  if (!mapped) {
    // Never invent a type. A String fallback would silently truncate a numeric column.
    return { type: null, warning: `No CDS mapping for HANA type "${attr.datatype}"` };
  }
  if (NO_LENGTH.has(mapped)) return { type: mapped, warning: null };

  if (mapped === 'Decimal') {
    if (attr.length == null || attr.length === '') {
      return { type: 'Decimal', warning: `DECIMAL column "${attr.id}" has no precision in NEO` };
    }
    const scale = attr.scale != null && attr.scale !== '' ? attr.scale : 0;
    return { type: `Decimal(${attr.length}, ${scale})`, warning: null };
  }
  if (attr.length == null || attr.length === '') {
    return { type: mapped, warning: `"${attr.id}" is ${hana} with no length in NEO` };
  }
  return { type: `${mapped}(${attr.length})`, warning: null };
}

/** Column names padded into a column so the generated file reads like the shipped ones. */
function pad(names) {
  const width = Math.max(0, ...names.map((n) => n.length));
  return (n) => n + ' '.repeat(width - n.length);
}

/**
 * Author a CDS proxy for one calc view.
 *
 * @param {object} cv          parsed calc view (parsers/calcview.js)
 * @param {object} cfg         project config
 * @param {object} opts
 * @param {string} opts.entityName   full proxy entity name (container + view name)
 * @param {string[]} [opts.keys]     key columns, if known from the .xsodata
 * @returns {{text:string, entityName:string, columns:number, keys:string[], warnings:string[]}}
 */
function generateProxy(cv, cfg, opts = {}) {
  const pc = cfg.cdsProxy || {};
  const typeMap = { ...DEFAULT_TYPE_MAP, ...(pc.typeMap || {}) };
  const withTitles = pc.includeTitles !== false;   // 195 of 204 shipped proxies carry @title
  const entityName = opts.entityName;
  if (!entityName) throw new Error('generateProxy requires opts.entityName');

  const warnings = [];
  const attrs = cv.viewAttributes || [];
  if (!attrs.length) warnings.push('Calc view declares no viewAttributes — the proxy would be empty.');

  // Keys come from the .xsodata when the caller knows them. A proxy with no key still
  // compiles; `xsodata-key` is what adds one later, and reports when NEO names none.
  const keySet = new Set((opts.keys || []).map((k) => String(k).toUpperCase()));
  const unmatched = [...keySet].filter((k) => !attrs.some((a) => String(a.id).toUpperCase() === k));
  for (const k of unmatched) {
    warnings.push(`Key column "${k}" from the .xsodata does not exist on this view — not marked.`);
  }

  // Resolve every column first, so the name and type columns can be padded to a
  // consistent width the way the hand-authored proxies are.
  const cols = [];
  for (const a of attrs) {
    const { type, warning } = cdsType(a, typeMap);
    if (warning) warnings.push(warning);
    if (!type) continue;                       // skip rather than emit a wrong column
    const isKey = keySet.has(String(a.id).toUpperCase());
    const ident = cdsIdent(a.id);
    cols.push({ label: isKey ? `key ${ident}` : ident, type, id: a.id });
  }

  const padName = pad(cols.map((c) => c.label));
  const padType = pad(cols.map((c) => c.type));
  const lines = cols.map((c) => {
    // The annotation belongs INSIDE the element definition — the `;` terminates the
    // whole thing. Emitting `String(100); @title: '…'` is a CDS syntax error.
    const title = withTitles ? ` ${padType(c.type)} @title: '${c.id}'` : ` ${c.type}`;
    return `  ${padName(c.label)} :${title};`;
  });

  // A parameterized calc view is addressed as entity NAME (P : Type, ...) in CAP.
  // 185 of 546 corpus views take parameters, so this is not an edge case.
  //
  // Parameter names are kept EXACTLY as NEO declares them. This proxy addresses the
  // calculation view, whose parameters are defined in its own XML — unlike the table
  // function signature, which `naming.uppercaseParameters` governs. The shipped
  // proxies disagree with themselves here (`pTABID` written as `ptabid`, `f6ezrfrg`
  // written as `F6EZRFRG`), so there is no precedent to copy; NEO's own spelling is
  // the only defensible source.
  const params = (cv.parameters || []).map((p) => {
    const { type, warning } = cdsType(p, typeMap);
    if (warning) warnings.push(`parameter ${warning}`);
    return `${cdsIdent(p.id)} : ${type || 'String'}`;
  });
  const signature = params.length ? ` (${params.join(', ')})` : '';

  if (params.length) {
    warnings.push(
      `Parameterized proxy (${params.length} parameter(s)). Parameter name casing is taken ` +
      'verbatim from NEO and has never been verified against a live HDI deploy — check this first.'
    );
  }

  const text =
    '@cds.persistence.exists\n' +
    '@cds.persistence.calcview\n' +
    `entity ${entityName}${signature} {\n` +
    lines.join('\n') + '\n' +
    '};\n';

  return {
    text,
    entityName,
    columns: lines.length,
    keys: (opts.keys || []).filter((k) => !unmatched.includes(String(k).toUpperCase())),
    warnings,
  };
}

export { generateProxy, cdsType, DEFAULT_TYPE_MAP, NO_LENGTH };
