/**
 * What every NEO file extension is, and whether we convert it.
 *
 * Folders are classified by the extensions of the files inside them, never by
 * their name. The corpus makes that non-negotiable: `Views` (41 folders) and
 * `View` (2) are distinct real folders rather than a typo, `.xsodata` lives in
 * `Services` and in a dozen lowercase folders like `icbcactionitems`, and
 * `Library` folders hold `.xsjslib`, `.xsodata` *and* `.xsjs`. Any rule that
 * keys off the folder name matches the wrong folder somewhere in this corpus.
 */

/** kind → what the emitter for it produces. */
export const KIND = Object.freeze({
  CALCVIEW: 'calcview',
  PROCEDURE: 'procedure',
  SERVICE: 'service', // .xsodata — the OData model
  LIBRARY: 'library', // .xsjs / .xsjslib — the JS tier
  TABLE: 'table',
  EXCLUDED: 'excluded', // recognised, deliberately not converted
  UNKNOWN: 'unknown',
});

/**
 * Every extension seen across both reference corpora, plus the XS Classic types
 * they do not happen to use. `convert: false` is a decision, not an omission —
 * see SESSION-CONTEXT.md D6/D7.
 */
const TYPES = {
  // --- converted ---
  calculationview: { kind: KIND.CALCVIEW, convert: true },
  hdbcalculationview: { kind: KIND.CALCVIEW, convert: true },
  hdbprocedure: { kind: KIND.PROCEDURE, convert: true },
  hdbtablefunction: { kind: KIND.PROCEDURE, convert: true },
  hdbfunction: { kind: KIND.PROCEDURE, convert: true },
  xsodata: { kind: KIND.SERVICE, convert: true },
  xsjs: { kind: KIND.LIBRARY, convert: true },
  xsjslib: { kind: KIND.LIBRARY, convert: true },

  // --- recognised, deliberately excluded ---
  // D7: tables are generated from the live DB by separate scripts.
  hdbtable: { kind: KIND.TABLE, convert: false, why: 'generated from the live DB, not migrated' },
  hdbindex: { kind: KIND.TABLE, convert: false, why: 'belongs with its table' },
  // D6: unused in the CF app.
  xsjob: { kind: KIND.EXCLUDED, convert: false, why: 'schedulers are out of scope', readForFacts: true },
  xshttpdest: { kind: KIND.EXCLUDED, convert: false, why: 'destinations are configured in BTP' },
  xsaccess: { kind: KIND.EXCLUDED, convert: false, why: 'auth is expressed in xs-security.json' },
  xsprivileges: { kind: KIND.EXCLUDED, convert: false, why: 'auth is expressed in xs-security.json' },
  analyticprivilege: { kind: KIND.EXCLUDED, convert: false, why: 'auth is expressed in xs-security.json' },
  xsapp: { kind: KIND.EXCLUDED, convert: false, why: 'app marker, no CF equivalent' },

  // --- XS Classic types absent from both corpora. Listed so an unseen one is
  //     reported as a known-but-unhandled type rather than silently ignored. ---
  hdbview: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  hdbdd: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  hdbstructure: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  hdbsequence: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  hdbsynonym: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  hdbrole: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  hdbschema: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  hdbti: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  hdbtextbundle: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  xssqlcc: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  attributeview: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
  analyticview: { kind: KIND.EXCLUDED, convert: false, why: 'no migration rule established' },
};

export const extensionOf = (name) => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};

/** @returns {{ext:string, kind:string, convert:boolean, why?:string, known:boolean}} */
export function classifyFile(name) {
  const ext = extensionOf(name);
  const t = TYPES[ext];
  if (!t) return { ext, kind: KIND.UNKNOWN, convert: false, known: false };
  return { ext, ...t, known: true };
}

/**
 * A folder's kind is the kind of the convertible files inside it. A folder
 * holding several kinds (a `Library/` with both `.xsjslib` and `.xsodata`, which
 * the corpus does contain) reports every kind it holds — the caller emits one
 * unit per kind rather than forcing a single label.
 *
 * @param {string[]} fileNames files directly inside the folder, not recursive
 * @returns {{kinds:string[], counts:Record<string,number>, excluded:number, unknown:string[]}}
 */
export function classifyFolder(fileNames) {
  const counts = {};
  const unknown = [];
  let excluded = 0;

  for (const name of fileNames) {
    const c = classifyFile(name);
    if (!c.known) {
      if (c.ext) unknown.push(name);
      continue;
    }
    if (!c.convert) {
      excluded++;
      continue;
    }
    counts[c.kind] = (counts[c.kind] || 0) + 1;
  }

  return { kinds: Object.keys(counts).sort(), counts, excluded, unknown };
}
