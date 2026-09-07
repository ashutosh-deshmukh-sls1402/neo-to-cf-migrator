/**
 * PORTED from migration-cleanup-toolkit/src/parsers/xsodata.js (CJS -> ESM).
 * Parses the .xsodata grammar: entities, aliases, keys, navigates, associations,
 * and `create using` endpoints.
 */
/**
 * .xsodata parser.
 *
 * The NEO OData service definition. It is the authority for several things the
 * assistant loses on the way to CAP:
 *
 *   key("COL")                     -> which CDS proxy columns get `key`
 *   with("A","B")                  -> the payload shape of a create endpoint
 *   navigates(...) + association   -> CAP associations
 *   create using "pkg:lib::func"   -> a CAP action (the assistant emits a plain
 *                                     projection instead, dropping the endpoint)
 *   create|update|delete forbidden -> @readonly
 *
 * Parsing strategy: strip comments, then split the service body into statements on
 * top-level semicolons and classify each one.
 *
 * The prior art (`CDS Key Migration Utility/lib/xsodata-parser.js`) instead scanned
 * forward 500 characters from each entity looking for a `key(...)`. That silently
 * attaches the NEXT entity's key when an entity has none of its own — and entities
 * without keys are exactly the case that matters. Statement splitting removes the
 * guesswork.
 */

/** Remove // and block comments without disturbing string literals. */
function stripComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      const stop = end === -1 ? text.length : end + 1;
      out += text.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Split on semicolons that are not inside a quoted string. */
function splitStatements(body) {
  const out = [];
  let cur = '', inStr = false;
  for (const ch of body) {
    if (ch === '"') inStr = !inStr;
    if (ch === ';' && !inStr) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Contents of the outermost `service { ... }` block. */
function serviceBody(text) {
  const open = /\bservice\b[^{]*\{/.exec(text);
  if (!open) return null;
  const start = open.index + open[0].length;
  let depth = 1, i = start, inStr = false;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '"') inStr = !inStr;
    else if (!inStr && ch === '{') depth++;
    else if (!inStr && ch === '}') depth--;
    i++;
  }
  return text.slice(start, depth === 0 ? i - 1 : text.length);
}

const quotedList = (s) => [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1]);

/** `name(...)` argument list, or null when absent. */
function clauseArgs(stmt, name) {
  const re = new RegExp(`\\b${name}\\s*\\(([^)]*)\\)`, 'i');
  const m = re.exec(stmt);
  return m ? quotedList(m[1]) : null;
}

function parseEntity(stmt) {
  // "NAMESPACE::EntityName" [as "Alias"] ...
  const head = /^"([^"]*?)::([^"]+)"\s*(?:as\s+"([^"]+)")?/i.exec(stmt);
  if (!head) return null;

  const createUsing = /\bcreate\s+using\s+"([^"]+)"/i.exec(stmt);
  let lib = null, func = null;
  if (createUsing) {
    // "ICBC.JBD.CommonFolder.Library:common.xsjslib::errorLogUI"
    const m = /^(.*?):([^:]*?)::(.+)$/.exec(createUsing[1]);
    if (m) { lib = `${m[1]}:${m[2]}`; func = m[3]; }
    else func = createUsing[1];
  }

  const navRaw = /\bnavigates\s*\(([^)]*)\)/i.exec(stmt);
  const navigates = navRaw
    ? [...navRaw[1].matchAll(/"([^"]+)"\s*as\s*"([^"]+)"/gi)].map((m) => ({ association: m[1], target: m[2] }))
    : [];

  const forbidden = ['create', 'update', 'delete'].filter(
    (op) => new RegExp(`\\b${op}\\s+forbidden\\b`, 'i').test(stmt)
  );

  return {
    kind: 'entity',
    namespace: head[1],
    entity: head[2],
    alias: head[3] ?? head[2],
    keys: clauseArgs(stmt, 'key') ?? clauseArgs(stmt, 'keys') ?? [],
    with: clauseArgs(stmt, 'with') ?? [],
    navigates,
    forbidden,
    createUsing: createUsing ? { raw: createUsing[1], lib, func } : null,
    readonly: forbidden.length === 3,
  };
}

function parseAssociation(stmt) {
  const name = /\bassociation\s+"([^"]+)"/i.exec(stmt);
  if (!name) return null;
  const principal = /\bprincipal\s+"([^"]+)"\s*\(([^)]*)\)(?:\s*multiplicity\s*"([^"]*)")?/i.exec(stmt);
  const dependent = /\bdependent\s+"([^"]+)"\s*\(([^)]*)\)(?:\s*multiplicity\s*"([^"]*)")?/i.exec(stmt);
  return {
    kind: 'association',
    name: name[1],
    principal: principal ? { alias: principal[1], columns: quotedList(principal[2]), multiplicity: principal[3] ?? null } : null,
    dependent: dependent ? { alias: dependent[1], columns: quotedList(dependent[2]), multiplicity: dependent[3] ?? null } : null,
  };
}

/**
 * @param {string} raw contents of a .xsodata file
 * @returns {{entities:object[], associations:object[], byAlias:Map, byEntity:Map, unparsed:string[]}}
 */
function parseXsodata(raw) {
  const body = serviceBody(stripComments(raw));
  const entities = [], associations = [], unparsed = [];

  if (body) {
    for (const stmt of splitStatements(body)) {
      if (/^association\b/i.test(stmt)) {
        const a = parseAssociation(stmt);
        if (a) associations.push(a); else unparsed.push(stmt);
        continue;
      }
      if (/^"/.test(stmt)) {
        const e = parseEntity(stmt);
        if (e) entities.push(e); else unparsed.push(stmt);
        continue;
      }
      unparsed.push(stmt);
    }
  }

  return {
    entities,
    associations,
    unparsed,
    byAlias: new Map(entities.map((e) => [e.alias.toUpperCase(), e])),
    byEntity: new Map(entities.map((e) => [e.entity.toUpperCase(), e])),
  };
}

export { parseXsodata, stripComments, splitStatements, serviceBody };
