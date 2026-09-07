/**
 * The task registry — Tier 2.
 *
 * Every task here obeys the same three rules, which are what make a *small*
 * model safe to use (CONVERSION-STRATEGY.md §9):
 *
 *   1. **The model answers a question, it does not write the code.** The answer
 *      re-enters Tier 1 and the conversion is emitted by the same deterministic
 *      code that emits everything else. Nothing a model returns is ever spliced
 *      into a file.
 *   2. **The prompt asserts every fact.** Anything the model would otherwise
 *      have to invent — the SQL, the expression, the surrounding code — is
 *      given. Anything not given, it must answer `unknown` for.
 *   3. **The validator checks something semantic.** Never "it parsed". A task
 *      whose answer cannot be checked against the SQL or the AST does not
 *      belong here — it belongs in the report, as a refusal.
 *
 * ── the one task ─────────────────────────────────────────────────────────────
 *
 * `hole-classify`. §20 established that a value spliced into SQL converts three
 * different ways depending on where it sits, and that quote parity decides it:
 * inside `'…'` it is a value, inside `"…"` it is an identifier. §26 took that as
 * far as it goes deterministically. What is left — 18 of the last 20 refusals —
 * is the case quote parity cannot decide:
 *
 *     WHERE CATID NOT IN (<hole>)      a list of ids built up in a loop?
 *     LIMIT <hole>                     a number?
 *     FROM <hole>                      a table name?
 *
 * That is a judgement about code, which is exactly what a model is for, and the
 * answer is **one word per hole**. The conversion that follows the answer is the
 * §26 code, unchanged. A model that says `value` about a table name gets caught
 * by the SQL grammar check below; a model that says `unknown` costs us nothing,
 * because `unknown` is where we already were.
 */

/** Positions where a bind parameter is not legal SQL, whatever the model says. */
const IDENTIFIER_ONLY = /\b(FROM|JOIN|INTO|UPDATE|TABLE|PROCEDURE|SCHEMA|USER|VIEW|INDEX|SEQUENCE)\s*$/i;
/** Positions where an identifier makes no sense — a value must follow. */
const VALUE_ONLY = /(=|<|>|<=|>=|<>|!=|\bLIKE|\bVALUES\s*\(|,)\s*$/i;

const KINDS = new Set(['value', 'list', 'identifier', 'unknown']);

/** The lines leading up to the statement — where a hole's value is built. */
function contextBefore(source, offset, lines = 25) {
  const upto = source.slice(0, offset).split('\n');
  return upto.slice(Math.max(0, upto.length - lines)).join('\n');
}

const holeMarker = (i) => `<<HOLE ${i}>>`;

/** The SQL as the model should see it: holes marked, existing binds left as `?`. */
function markedSql(template) {
  let sql = template.sql;
  for (let i = 0; i < template.holes.length; i++) sql = sql.replace(`__NEO_HOLE_${i}__`, holeMarker(i));
  return sql;
}

const PROMPT = `You are converting SAP HANA XS Classic (NEO) JavaScript to SAP CAP.

A SQL statement is built by string concatenation. Every run-time value in it has
been marked <<HOLE n>>. Existing bind parameters are shown as ?.

For EACH hole, answer with exactly one of:

  "value"       one single value that SQL could bind as a parameter
                (a number, a date, one id) — it would still be correct written
                as ? with the value bound
  "list"        several values at once, or a fragment of SQL text: a
                comma-separated list of ids, an IN-list, a piece of a WHERE
                clause. One ? cannot stand for it.
  "identifier"  a table, view, schema or column NAME
  "unknown"     you cannot tell from what you were given

Rules:
- Answer "unknown" whenever you are not sure. It is the correct answer, not a
  failure — the statement is then left for a human, which is where it is now.
- Do not answer about anything except the holes listed.
- Reply with JSON only, no prose, no markdown fence:
  {"holes":[{"index":0,"kind":"value"},{"index":1,"kind":"identifier"}]}
`;

export const holeClassify = {
  name: 'hole-classify',

  /**
   * The ceiling rule (§22): only spend a call where the answer is the ONLY
   * thing between this statement and a conversion.
   */
  applies(chain) {
    const blockers = chain.gaps.filter((g) => g.level !== 'note');
    if (blockers.length !== 1 || blockers[0].code !== 'SQL_DYNAMIC') return false;
    return !!chain.sql.template?.holes?.length;
  },

  prompt(chain, { source }) {
    const t = chain.sql.template;
    const holes = t.holes.map((h, i) => `  <<HOLE ${i}>>  is the JavaScript expression:  ${source.slice(h.node.start, h.node.end)}`);
    return [
      PROMPT,
      '--- FACTS ---',
      '',
      'The SQL, as assembled:',
      '',
      markedSql(t),
      '',
      'The holes:',
      ...holes,
      '',
      'The JavaScript leading up to the statement, verbatim:',
      '',
      contextBefore(source, chain.nodes.create.start),
      '',
      `--- ANSWER (JSON, ${t.holes.length} hole(s)) ---`,
    ].join('\n');
  },

  /** JSON, possibly wrapped in a fence or a sentence the model could not resist. */
  parse(raw) {
    const text = String(raw).replace(/```(?:json)?/g, '');
    const at = text.indexOf('{');
    if (at === -1) return null;
    // The last `}` — a model that adds a trailing note leaves the JSON intact.
    const end = text.lastIndexOf('}');
    try {
      return JSON.parse(text.slice(at, end + 1));
    } catch {
      return null;
    }
  },

  /**
   * Semantic, not syntactic. Two things are checked against the SQL itself, and
   * they are the reason a wrong answer cannot reach a file:
   *
   *   - a hole after FROM/JOIN/INTO cannot be a bind parameter, whatever the
   *     model says — SQL has never allowed one there
   *   - a hole after `=`, `<`, `LIKE` or inside `VALUES(…)` cannot be an
   *     identifier, for the same reason in the other direction
   *
   * @returns {{kinds:string[]}|{reject:string}}
   */
  validate(answer, chain) {
    const t = chain.sql.template;
    if (!answer || !Array.isArray(answer.holes)) return { reject: 'the answer is not {"holes":[…]}' };
    if (answer.holes.length !== t.holes.length) {
      return { reject: `answered for ${answer.holes.length} hole(s), the statement has ${t.holes.length}` };
    }

    const kinds = new Array(t.holes.length).fill(null);
    for (const h of answer.holes) {
      const i = Number(h?.index);
      if (!Number.isInteger(i) || i < 0 || i >= t.holes.length) return { reject: `hole index ${h?.index} does not exist` };
      if (!KINDS.has(h.kind)) return { reject: `"${h.kind}" is not one of value/list/identifier/unknown` };
      if (kinds[i]) return { reject: `hole ${i} answered twice` };
      kinds[i] = h.kind;
    }
    if (kinds.some((k) => !k)) return { reject: 'not every hole was answered' };

    for (const [i, kind] of kinds.entries()) {
      const before = t.sql.slice(0, t.holes[i].at).replace(/\s+$/, ' ');
      if (kind === 'value' && IDENTIFIER_ONLY.test(before)) {
        return { reject: `hole ${i} follows ${before.trim().split(/\s+/).pop()}, where SQL cannot take a bind parameter` };
      }
      if (kind === 'identifier' && VALUE_ONLY.test(before)) {
        return { reject: `hole ${i} sits where a value belongs, so it cannot be an identifier` };
      }
    }
    return { kinds };
  },
};

export const TASKS = [holeClassify];
