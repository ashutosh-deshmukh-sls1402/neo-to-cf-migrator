/**
 * Project configuration.
 *
 * The engine holds no project literals. Defaults here are *format* defaults —
 * how to build an identifier — never project values. Anything project-specific
 * with no safe default stays null so the rule that needs it emits a finding
 * instead of inventing something.
 */

export const DEFAULTS = Object.freeze({
  /** Filled from intake, or overridden on the CLI. */
  schema: null,
  apps: [],

  /**
   * Package segments between the schema and the root of the tree being
   * converted — set only when converting a subfolder of a NEO repository.
   * `null` (the default) infers it from the .xsodata references; `''` takes the
   * paths literally. See inferRootPackage in convert.js.
   */
  rootPackage: null,

  schemas: {
    /**
     * Schema qualifiers to strip from generated SQL (checklist items 8/12/23).
     * Defaults to [schema] once intake has inferred it — a foreign schema is
     * reported, never stripped, because stripping it would silently repoint the
     * query at the local container.
     */
    strippable: null,
  },

  naming: {
    functionFilePrefix: 'TABLE_FUNCTION_',
    uppercaseParameters: true,
    /** Prefix used when renaming a numeric-leading identifier. */
    numericLeadingPrefix: 'E',
  },

  generator: {
    resultVariable: 'var_out',
    sessionUserReplacement: "SESSION_CONTEXT('APPLICATIONUSER')",
    returnStatement: null, // derived from resultVariable
  },

  sqlHygiene: {
    /** NEO writes `AS COUNT` / `AS VALUE` bare; HANA rejects or folds them. */
    reservedWords: null, // null = use the scanner's default list
  },

  serviceActions: {
    /** What a `create using` action answers with. */
    returnType: 'String',
    /**
     * The type of the payload parameter. NEO passed the request body through a
     * temporary table; CAP passes it as an action parameter, and its *name* is
     * not configurable — it is the column the handler reads, so that
     * `req.data.<name>` in the handler and the declaration cannot disagree.
     */
    payloadType: 'LargeString',
  },

  cdsProxy: {
    /** HANA -> CDS type map. Overridable per project. */
    typeMap: null, // null = the emitter's default
    /**
     * How many files the proxy entities are spread over.
     *
     *   null (default)  one `.cds` per calc view, mirroring the NEO folder tree
     *   'all'           every entity in a single `db/cds/schema.cds`
     *   'module'        one per top-level module, `db/cds/<MOD>/<MOD>_schema.cds`
     */
    bundle: null,
  },
});

/** Deep-merge user config over the defaults. */
export function resolveConfig(user = {}, intake = null) {
  const cfg = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(user)) {
    cfg[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...cfg[k], ...v } : v;
  }
  if (intake) {
    cfg.schema ??= intake.schema;
    if (!cfg.apps.length) cfg.apps = intake.apps;
  }
  // Only the project's own schema is strippable unless told otherwise.
  cfg.schemas.strippable ??= cfg.schema ? [cfg.schema] : [];
  cfg.generator.returnStatement ??= `return :${cfg.generator.resultVariable};`;
  return cfg;
}
