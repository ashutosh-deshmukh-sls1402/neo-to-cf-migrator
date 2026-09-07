
/**
 * SQLScript segment scanner.
 *
 * Every SQL transform in this toolkit runs through here rather than over raw text,
 * because a blind regex replace over SQL corrupts string literals and comments.
 * TOOL_CONTEXT.md §2.1 records exactly that failure: an earlier naive schema-strip
 * replaced the quote character instead of the whole qualifier and left a stray `"`
 * that only surfaced at HDI deploy time.
 *
 * Segment kinds:
 *   code          executable SQL
 *   string        '...' literal (with '' escape) — NEVER transformed
 *   quotedIdent   "..." delimited identifier
 *   lineComment   -- to end of line
 *   blockComment  slash-star ... star-slash
 */

const KIND = Object.freeze({
  CODE: 'code',
  STRING: 'string',
  QUOTED_IDENT: 'quotedIdent',
  LINE_COMMENT: 'lineComment',
  BLOCK_COMMENT: 'blockComment',
});

/** @returns {{kind:string, text:string, start:number}[]} */
function scan(sql) {
  const segs = [];
  let i = 0, codeStart = 0;

  const pushCode = (end) => {
    if (end > codeStart) segs.push({ kind: KIND.CODE, text: sql.slice(codeStart, end), start: codeStart });
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      pushCode(i);
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      segs.push({ kind: KIND.LINE_COMMENT, text: sql.slice(i, stop), start: i });
      i = codeStart = stop;
      continue;
    }

    if (ch === '/' && next === '*') {
      pushCode(i);
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      segs.push({ kind: KIND.BLOCK_COMMENT, text: sql.slice(i, stop), start: i });
      i = codeStart = stop;
      continue;
    }

    if (ch === "'") {
      pushCode(i);
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }  // '' escape
          j++; break;
        }
        j++;
      }
      segs.push({ kind: KIND.STRING, text: sql.slice(i, j), start: i });
      i = codeStart = j;
      continue;
    }

    if (ch === '"') {
      pushCode(i);
      let j = sql.indexOf('"', i + 1);
      j = j === -1 ? sql.length : j + 1;
      segs.push({ kind: KIND.QUOTED_IDENT, text: sql.slice(i, j), start: i });
      i = codeStart = j;
      continue;
    }

    i++;
  }
  pushCode(sql.length);
  return segs;
}

const render = (segs) => segs.map((s) => s.text).join('');

/** Content of a quotedIdent segment without its surrounding quotes. */
const identName = (seg) => (seg.kind === KIND.QUOTED_IDENT ? seg.text.slice(1, -1) : null);

/**
 * Find every `"SCHEMA"."TABLE"` qualifier.
 * @returns {{schema:string, table:string|null, index:number}[]}
 */
function findSchemaQualifiers(sql) {
  const segs = scan(sql);
  const out = [];
  for (let n = 0; n < segs.length; n++) {
    const s = segs[n];
    if (s.kind !== KIND.QUOTED_IDENT) continue;
    const after = segs[n + 1];
    // A qualifier is "X" immediately followed by a '.' starting the next code segment.
    if (!after || after.kind !== KIND.CODE || !after.text.startsWith('.')) continue;
    const target = segs[n + 2];
    out.push({
      schema: identName(s),
      table: target && target.kind === KIND.QUOTED_IDENT ? identName(target) : null,
      index: s.start,
    });
  }
  return out;
}

/**
 * Remove `"SCHEMA".` for each schema in `strippable`, leaving the table bare.
 *
 * Removes the ENTIRE qualifier plus its dot — never a quote character on its own.
 * Foreign schemas are left completely untouched (DECISIONS.md §6); detecting and
 * reporting them is the caller's job.
 *
 * @returns {{sql:string, stripped:{schema:string,table:string|null}[]}}
 */
function stripSchemaQualifiers(sql, strippable) {
  const wanted = new Set((strippable || []).map((s) => s.toUpperCase()));
  const segs = scan(sql);
  const stripped = [];
  const keep = new Array(segs.length).fill(true);

  for (let n = 0; n < segs.length; n++) {
    const s = segs[n];
    if (s.kind !== KIND.QUOTED_IDENT) continue;
    const name = identName(s);
    if (!wanted.has(String(name).toUpperCase())) continue;

    const after = segs[n + 1];
    if (!after || after.kind !== KIND.CODE || !after.text.startsWith('.')) continue;

    const target = segs[n + 2];
    stripped.push({
      schema: name,
      table: target && target.kind === KIND.QUOTED_IDENT ? identName(target) : null,
    });

    keep[n] = false;                                  // drop "SCHEMA" entirely
    segs[n + 1] = { ...after, text: after.text.slice(1) }; // drop the leading '.'
  }

  return { sql: render(segs.filter((_, n) => keep[n])), stripped };
}

/**
 * Apply a replacement to executable code only — never inside literals, comments,
 * or delimited identifiers.
 */
function replaceInCode(sql, pattern, replacement) {
  let count = 0;
  const segs = scan(sql).map((s) => {
    if (s.kind !== KIND.CODE) return s;
    const text = s.text.replace(pattern, (...args) => {
      count++;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
    return { ...s, text };
  });
  return { sql: render(segs), count };
}

/** True if `word` appears as an identifier in executable code. */
function codeHasWord(sql, word) {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return scan(sql).some((s) => s.kind === KIND.CODE && re.test(s.text));
}

/**
 * Undo the assistant's fabricated container over-prefix on table identifiers
 * (TOOL_CONTEXT.md §2.2 item 12): `"ICBC_JBD_..._LOCPD_RHA_M_EMPLY"` -> `"M_EMPLY"`.
 *
 * The function's OWN name is legitimately prefixed and must survive, so any
 * identifier containing the function-file prefix is left alone.
 *
 * Used to normalise raw assistant output before comparing it with NEO, so that
 * mechanical prefixing does not masquerade as content corruption.
 *
 * @returns {{sql:string, count:number}}
 */
function dePrefixIdentifiers(sql, containerBase, functionPrefix = 'TABLE_FUNCTION_') {
  if (!containerBase) return { sql, count: 0 };
  const marker = `${containerBase}_`.toUpperCase();
  let count = 0;

  const segs = scan(sql).map((s) => {
    if (s.kind !== KIND.QUOTED_IDENT) return s;
    const name = identName(s);
    if (!name || name.toUpperCase().includes(functionPrefix.toUpperCase())) return s;
    if (!name.toUpperCase().startsWith(marker)) return s;
    count++;
    return { ...s, text: `"${name.slice(marker.length)}"` };
  });

  return { sql: render(segs), count };
}

/**
 * HANA reserved words that realistically appear as column aliases. Quoting these is
 * required; leaving them bare is a compile error or a silent fold.
 *
 * Deliberately NOT the full reserved list — this is applied automatically, so it is
 * limited to words genuinely seen or plausibly used as aliases. Extend via config.
 */
const DEFAULT_RESERVED_WORDS = [
  'COUNT', 'VALUE', 'TYPE', 'DATE', 'TIME', 'TIMESTAMP', 'YEAR', 'MONTH', 'DAY',
  'HOUR', 'MINUTE', 'SECOND', 'LEVEL', 'ORDER', 'GROUP', 'KEY', 'USER', 'LANGUAGE',
  'START', 'END', 'CHECK', 'CURRENT', 'DEFAULT', 'FULL', 'LIMIT', 'OFFSET', 'PATH',
  'RESULT', 'ROW', 'ROWS', 'SESSION', 'SOME', 'SUM', 'TOP', 'UNION', 'VIEW', 'WHERE',
];

/**
 * Quote reserved-word aliases: `AS COUNT` -> `AS "COUNT"`.
 *
 * Only touches aliases that are ALREADY fully uppercase. An unquoted mixed-case alias
 * folds to uppercase in HANA, so quoting it verbatim would change the resulting column
 * name — the opposite of the intent. Uppercase aliases quote losslessly.
 *
 * Runs on executable code only, so a literal or comment containing `AS COUNT` is safe.
 *
 * @returns {{sql:string, quoted:string[]}}
 */
function quoteReservedAliases(sql, reserved = DEFAULT_RESERVED_WORDS) {
  const set = new Set(reserved.map((w) => w.toUpperCase()));
  const quoted = [];

  const segs = scan(sql).map((s) => {
    if (s.kind !== KIND.CODE) return s;
    const text = s.text.replace(/\bAS\s+([A-Z_][A-Z0-9_]*)\b/g, (m, word) => {
      if (!set.has(word)) return m;
      quoted.push(word);
      return m.replace(new RegExp(`\\b${word}\\b`), `"${word}"`);
    });
    return { ...s, text };
  });

  return { sql: render(segs), quoted };
}

export {
  scan, render, KIND, identName,
  findSchemaQualifiers, stripSchemaQualifiers, replaceInCode, codeHasWord,
  dePrefixIdentifiers, quoteReservedAliases, DEFAULT_RESERVED_WORDS,
};
