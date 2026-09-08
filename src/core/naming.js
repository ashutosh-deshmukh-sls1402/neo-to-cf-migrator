/**
 * Identifier transforms: the calc-view flattening rule, and the numeric-leading
 * rename.
 *
 * Both are pure functions over strings so they can be tested without a corpus.
 */

/**
 * A HANA calc view's fully-qualified NEO name is
 * `<SCHEMA>.<APP>.<MODULE>[.<SUB>].Views::<ViewName>`. The CAP proxy entity name
 * is that whole path with every separator flattened and uppercased.
 *
 *   TECK.JOB_BIDDING.JB_ADMIN_CONSOLE.Views::TECK_M_getSUPList
 *   -> TECK_JOB_BIDDING_JB_ADMIN_CONSOLE_VIEWS_TECK_M_GETSUPLIST
 *
 * Mixed-case HANA object names lose their casing; that is the rule, not a bug.
 */
export function flattenEntityName(qualifiedName) {
  return String(qualifiedName)
    .replace(/::/g, '_')
    .replace(/\./g, '_')
    .toUpperCase();
}

/**
 * The call path for a procedure, used by `cds.run('CALL ...')`. Same flattening,
 * but case is preserved and the name is left unquoted — HANA resolves it
 * case-insensitively, which is what checklist item 13 relies on.
 */
export function flattenCallPath(qualifiedName) {
  return String(qualifiedName).replace(/::/g, '_').replace(/\./g, '_');
}

/**
 * CDS keywords that cannot be an element name on their own.
 *
 * Derived by feeding `entity E { <word> : String(5); }` to `@sap/cds-compiler`
 * 7.1.0 for every CDS keyword and keeping the ones it refused — not from the
 * grammar, and not from memory. A NEO calc view with a column called `KEY`
 * produced `key : String(50)`, which the parser reads as the `key` modifier
 * with its name missing: "Mismatched ':', expecting <Identifier>".
 */
const CDS_RESERVED = new Set([
  'all', 'as', 'by', 'case', 'cast', 'distinct', 'exists', 'false', 'from', 'in',
  'key', 'not', 'null', 'of', 'on', 'select', 'true', 'when', 'where', 'with',
]);

/**
 * A column or parameter name as CDS must see it.
 *
 * `![NAME]` is CDS's delimited identifier and keeps the name itself untouched,
 * which matters: it is the deployed column name and a UI asks for it by that
 * spelling. Every reserved word above compiles when written this way.
 */
export function cdsIdent(name) {
  return CDS_RESERVED.has(String(name).toLowerCase()) ? `![${name}]` : String(name);
}

/** CDS/HDI reject any identifier starting with a digit. */
export const startsWithDigit = (name) => /^[0-9]/.test(String(name));

/**
 * A name CDS can use as an element or an alias without help.
 *
 * A leading digit is one way to fail it; so is a character CDS does not allow in
 * a name at all. The corpus has a navigation alias written `.Managerql6kfx366e`
 * — with the dot — and unlike a reserved word that one cannot be rescued by
 * writing `![…]`: "The character '.' is not allowed in element names", says the
 * compiler, whatever the delimiters.
 */
export const isLegalIdent = (name) => /^[A-Za-z_][A-Za-z_0-9]*$/.test(String(name));

/**
 * Rename a numeric-leading identifier deterministically.
 *
 * The reference project renamed these by hand and inconsistently — the same NEO
 * alias became `I…` in one module and `o…` in another, so a NEO alias could not
 * be mapped back to one CF name. A fixed prefix keeps the tail intact (so the
 * before/after stays traceable) and makes the mapping reproducible.
 *
 * These aliases are the OData names the UI calls, so every rename must reach the
 * UI team — see the rename registry below.
 */
export function renameNumericLeading(name, { prefix = 'E' } = {}) {
  const cleaned = String(name).replace(/[^A-Za-z_0-9]/g, '');
  if (!startsWithDigit(cleaned) && cleaned === String(name)) return String(name);
  return startsWithDigit(cleaned) || !cleaned ? prefix + cleaned : cleaned;
}

/**
 * Tracks every rename so the report can hand the UI team a before/after table,
 * and so a rename that collides with an existing name is caught rather than
 * silently shadowing it.
 */
export class RenameRegistry {
  constructor({ prefix = 'E' } = {}) {
    this.prefix = prefix;
    this.renames = new Map(); // original -> { to, sites: [] }
    this.taken = new Set();
  }

  /** Declare a name that already exists, so a rename cannot collide with it. */
  reserve(name) {
    this.taken.add(name);
  }

  /**
   * @returns {{name:string, renamed:boolean, collision?:string}}
   */
  resolve(original, site) {
    if (isLegalIdent(original)) {
      this.taken.add(original);
      return { name: original, renamed: false };
    }

    const existing = this.renames.get(original);
    if (existing) {
      existing.sites.push(site);
      return { name: existing.to, renamed: true };
    }

    let to = renameNumericLeading(original, { prefix: this.prefix });
    let collision;
    if (this.taken.has(to)) {
      // Deterministic escape hatch: keep appending the prefix until it is free.
      collision = to;
      while (this.taken.has(to)) to = this.prefix + to;
    }

    this.taken.add(to);
    this.renames.set(original, { to, sites: [site] });
    return { name: to, renamed: true, collision };
  }

  /** Rows for the report / entity-alias-changes table. */
  table() {
    return [...this.renames.entries()]
      .map(([from, v]) => ({ from, to: v.to, sites: v.sites }))
      .sort((a, b) => a.from.localeCompare(b.from));
  }
}

/** HDI identifiers are case-sensitive and must be double-quoted in SQL. */
export const quote = (n) => `"${String(n).replace(/"/g, '""')}"`;
