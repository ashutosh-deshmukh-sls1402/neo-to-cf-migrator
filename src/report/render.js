/**
 * Terminal rendering. One of only two modules allowed to produce display text
 * (the other is bin/neo2cf.js). Everything here takes data and returns a string
 * — nothing calls console.* — so the same functions can be tested and a UI can
 * ignore them entirely.
 */

const KIND_LABEL = {
  calcview: 'calculation views',
  procedure: 'procedures',
  service: 'OData services (.xsodata)',
  library: 'JS libraries/services',
};

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

/** Greedy wrap, so a long fix stays readable in an 80-column terminal. */
function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function renderInventory(r) {
  const out = [];
  const rule = '─'.repeat(64);

  out.push('');
  out.push(`  NEO tree   ${r.root}`);
  out.push(
    `  Schema     ${r.schema || '(could not infer)'}` +
      (r.schemaInferred ? '   inferred from $.import statements' : '   (from config)'),
  );
  if (r.schemaInferred && r.schemaEvidence.length > 1) {
    const others = r.schemaEvidence.slice(1).map((e) => `${e.name} (${e.imports})`).join(', ');
    out.push(`             other candidates seen: ${others}`);
  }
  out.push(
    `  App(s)     ${r.apps.length ? r.apps.join(', ') : '(none — everything sits directly under the schema)'}` +
      (r.appsInferred ? '   inferred' : '   (from config)'),
  );
  out.push('');

  // Warnings first: they change how the numbers below should be read.
  for (const w of r.warnings) {
    out.push(`  ${rule}`);
    out.push(`  ! ${w.message}`);
    for (const line of wrap(w.fix, 62)) out.push(`    ${line}`);
    out.push('');
  }

  out.push(`  ${rule}`);
  out.push(`  CONVERTIBLE`);
  out.push('');

  for (const [kind, n] of Object.entries(r.counts).sort((a, b) => b[1] - a[1])) {
    out.push(`    ${num(n, 5)}  ${KIND_LABEL[kind] || kind}`);
  }
  out.push(`    ${num(r.totals.convertible, 5)}  total`);
  out.push('');

  if (r.excludedFiles.length) {
    const byWhy = new Map();
    for (const f of r.excludedFiles) {
      const k = `${f.ext}|${f.why}`;
      byWhy.set(k, (byWhy.get(k) || 0) + 1);
    }
    out.push(`  ${rule}`);
    out.push(`  NOT CONVERTED — recognised, deliberately out of scope`);
    out.push('');
    for (const [k, n] of [...byWhy.entries()].sort((a, b) => b[1] - a[1])) {
      const [ext, why] = k.split('|');
      out.push(`    ${num(n, 5)}  ${pad('.' + ext, 20)} ${why}`);
    }
    out.push(`    ${num(r.totals.excluded, 5)}  total`);
    out.push('');
  }

  if (r.unknownFiles.length) {
    out.push(`  ${rule}`);
    out.push(`  UNRECOGNISED — no rule for these, they will be ignored`);
    out.push('');
    for (const f of r.unknownFiles.slice(0, 15)) out.push(`           ${f}`);
    if (r.unknownFiles.length > 15) out.push(`           … and ${r.unknownFiles.length - 15} more`);
    out.push('');
  }

  out.push(`  ${rule}`);
  out.push(`  SECTIONS — ${r.sections.length}`);
  out.push('');
  // A section usually spans sibling folders (Views/ + Procedures/ + Library/),
  // so several units share a kind. Aggregate, or the same kind prints twice.
  const ORDER = ['calcview', 'procedure', 'service', 'library'];
  for (const s of r.sections) {
    const byKind = {};
    for (const u of s.units) byKind[u.kind] = (byKind[u.kind] || 0) + u.files.length;
    const parts = ORDER.filter((k) => byKind[k])
      .map((k) => `${num(byKind[k], 3)} ${k}`)
      .join('  ');
    out.push(`    ${pad(s.path, 46)} ${parts}`);
  }
  out.push('');

  return out.join('\n');
}

export function renderError(err) {
  return `\n  ${err.message}\n`;
}

const ROLE_LABEL = {
  calcview: '.hdbcalculationview',
  tablefunction: 'TABLE_FUNCTION_*.hdbfunction',
  cdsproxy: 'db/cds proxy',
  procedure: '.hdbprocedure',
  servicecds: 'service.cds',
  servicejs: 'service.js',
  handler: 'srv handler .js',
};

export function renderScore(s) {
  const out = [];
  const rule = '─'.repeat(72);
  out.push('');
  out.push(`  NEO       ${s.intake.root}`);
  out.push(`  expected  ${s.expectedRoot}`);
  out.push('');
  out.push(`  ${rule}`);
  out.push(`  ${pad('ROLE', 30)}${num('MADE', 6)}${num('EXACT', 7)}${num('NAME', 6)}${num('GONE', 6)}${num('DROP', 6)}${num('NONE', 6)}   HIT`);
  out.push('');

  let tp = 0, te = 0, td = 0;
  for (const [role, r] of Object.entries(s.roles)) {
    const scored = r.predicted - (r.dropped || 0);
    tp += r.predicted;
    te += r.exact;
    td += r.dropped || 0;
    const pct = scored ? ((r.exact / scored) * 100).toFixed(1) : '—';
    out.push(
      `  ${pad(ROLE_LABEL[role] || role, 30)}${num(r.predicted, 6)}${num(r.exact, 7)}${num(r.sameDir, 6)}${num(r.missing, 6)}${num(r.dropped || 0, 6)}${num(r.notEmitted || 0, 6)}${num(pct + '%', 8)}`,
    );
  }
  const scoredTotal = tp - td;
  out.push('');
  const tn = Object.values(s.roles).reduce((n, r) => n + (r.notEmitted || 0), 0);
  out.push(`  ${pad('TOTAL', 30)}${num(tp, 6)}${num(te, 7)}${' '.repeat(18)}${num(tn, 6)}${num(((te / (scoredTotal || 1)) * 100).toFixed(1) + '%', 8)}`);
  out.push('');
  out.push('  MADE  = files `convert` actually wrote for this role — not paths it');
  out.push('          predicts. A NEO file whose conversion fails is in NONE, not here.');
  out.push('  EXACT = a file exists at the exact path we wrote');
  out.push('  NAME  = right folder, different file name  (naming rule is off)');
  out.push('  GONE  = the file exists elsewhere          (path rule is off)');
  out.push('  DROP  = no file of that name anywhere in the reference — the hand');
  out.push('          migration did not carry this NEO file across. Not scored:');
  out.push('          it measures their decisions, not ours.');
  out.push('  NONE  = NEO files this run produced nothing at all for. Each has its own');
  out.push('          finding; they are the real gap, and no path rule can hide them.');
  out.push('');

  if (s.unexplained.length) {
    out.push(`  ${rule}`);
    out.push(`  IN CF BUT NOT PREDICTED — ${s.unexplained.length}`);
    out.push('');
    const byTop = new Map();
    for (const p of s.unexplained) {
      const top = p.split('/').slice(0, 2).join('/');
      byTop.set(top, (byTop.get(top) || 0) + 1);
    }
    for (const [top, n] of [...byTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      out.push(`    ${num(n, 5)}  ${top}/…`);
    }
    out.push('');
  }
  return out.join('\n');
}

const GAP_HELP = {
  SQL_DYNAMIC: 'the SQL string is assembled at run time',
  BIND_CONDITIONAL: 'a parameter takes its value from a branch we cannot collapse',
  BIND_BATCHED: 'values accumulate across a loop before one execute',
  NO_EXEC: 'prepared and never executed — dead code, or a bug',
  BIND_COUNT_MISMATCH: 'the ? placeholders and the bound values disagree',
  CALL_OUT_UNKNOWN: 'a getter reads a CALL position the procedure does not declare as OUT',
  CALL_OUT_OUTSIDE_SCOPE: 'an OUT parameter is read where the call result is no longer in scope',
  CALL_OUT_NOT_ASSIGNABLE: 'the OUT values are read back but the execute() has nowhere to be named',
  COLUMN_OUT_OF_RANGE: 'a getter reads past the end of the SELECT list',
  COLUMN_UNNAMED: 'SELECT * — the columns are not written down anywhere',
  MULTI_EXEC: 'one statement executed more than once',
  MULTI_NEXT: 'the row cursor is stepped by hand',
  CURSOR_STEPPED: 'next() is not a while/if condition, so there is no loop to rewrite',
  READ_OUTSIDE_ROW: 'a column is read where the row no longer exists',
  DEFERRED_RESULT_SET: 'rows come from a separate getResultSet() call',
  DO_WHILE_CURSOR: 'the row loop is a do…while, not a for…of',
  BIND_INDEX_DYNAMIC: 'the parameter index is computed',
  STATEMENT_UNNAMED: 'the prepared statement is not held in a variable',
  RESULT_UNNAMED: 'the result set is not held in a variable',
  BIND_GAP: 'the parameter indices are not contiguous',
  SQL_MISSING: 'prepare called with no SQL',
  PARSE_FAILED: 'the file is not parseable JavaScript',
};

/** Notes are about statements that DID convert. */
const NOTE_HELP = {
  SQL_IDENTIFIER_INTERPOLATED:
    'a table or column name is written into the SQL, not bound — SQL cannot parameterise an identifier',
  SQL_VALUE_INTERPOLATED:
    'a value is written into the SQL, not bound — it is DDL, or a list one ? cannot stand for',
  READ_IN_CATCH:
    'a column is read in a catch block, so it reads the first row of the result rather than the loop’s row',
};

export function renderDbScan(s) {
  const out = [];
  const rule = '─'.repeat(72);
  const { stats } = s;
  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');

  out.push('');
  out.push(`  NEO tree   ${s.intake.root}`);
  out.push(`  JS files   ${stats.files}   (${stats.withDb} touch the database)`);
  if (stats.unparsed) out.push(`  UNPARSED   ${stats.unparsed}  — see below`);
  out.push('');
  out.push(`  ${rule}`);
  out.push(`  JDBC STATEMENTS — ${stats.chains}`);
  out.push('');
  out.push(`    ${num(stats.resolved, 5)}  converted automatically   ${pct(stats.resolved, stats.chains)}`);
  out.push(`    ${num(stats.chains - stats.resolved, 5)}  need a decision this tool will not make for you`);
  out.push('');
  out.push(`    ${num(stats.imports, 5)}  $.import(…) resolved to ES imports`);
  out.push(`    ${num(stats.entries, 5)}  request entry points found and exported as the default`);
  out.push('');
  out.push(`    ${num(stats.emitted, 5)}  files rewritten, of which ${stats.loads} produce loadable JavaScript` +
    (stats.emitted === stats.loads ? '' : `   ** ${stats.emitted - stats.loads} DO NOT **`));
  out.push('');

  // Tier 2 only appears when it ran. A model that was asked and declined is
  // reported as loudly as one that answered — they mean different things.
  if (stats.ai && stats.ai.asked) {
    out.push(`  ${rule}`);
    out.push('  TIER 2 — what the model was asked');
    out.push('');
    out.push(`    ${num(stats.ai.asked, 5)}  statement(s) asked about — only those one answer would convert`);
    out.push(`    ${num(stats.ai.accepted, 5)}  answered, checked, and converted`);
    for (const [why, n] of Object.entries(stats.ai.declined)) {
      out.push(`    ${num(n, 5)}  not converted — ${why}`);
    }
    out.push('');
    out.push('    Every one of these went back through Tier 1, which decided. The');
    out.push('    conversions are marked in the file and in the findings.');
    out.push('');
  }

  const row = (label, m) => {
    const parts = Object.entries(m).map(([k, n]) => `${n} ${k}`).join(',  ');
    if (parts) out.push(`    ${pad(label, 12)} ${parts}`);
  };
  row('kind', stats.byKind);
  row('result', stats.byShape);
  out.push('');

  const notes = Object.entries(stats.byNote || {});
  if (notes.length) {
    out.push(`  ${rule}`);
    out.push('  CONVERTED, BUT WORTH READING');
    out.push('');
    for (const [code, n] of notes) out.push(`    ${num(n, 5)}  ${pad(code, 28)} ${NOTE_HELP[code] || ''}`);
    out.push('');
  }

  const gaps = Object.entries(stats.byGap);
  if (gaps.length) {
    out.push(`  ${rule}`);
    out.push('  WHY THE REST NEED A DECISION');
    out.push('');
    for (const [code, n] of gaps) {
      out.push(`    ${num(n, 5)}  ${pad(code, 24)} ${GAP_HELP[code] || ''}`);
    }
    out.push('');
    // The files worth opening first: most unresolved statements in one place.
    const worst = s.files
      .filter((f) => f.total > f.resolved)
      .sort((a, b) => (b.total - b.resolved) - (a.total - a.resolved))
      .slice(0, 10);
    if (worst.length) {
      out.push(`  ${rule}`);
      out.push('  FILES TO LOOK AT FIRST');
      out.push('');
      for (const f of worst) out.push(`    ${num(f.total - f.resolved, 5)} of ${pad(String(f.total), 4)} ${f.path}`);
      out.push('');
    }
  }
  return out.join('\n');
}

const LEVEL_ORDER = { blocked: 0, warning: 1, note: 2 };

/** Findings grouped by code, commonest first — one entry stands for the group. */
function byCode(findings) {
  const groups = new Map();
  for (const f of findings) {
    if (!groups.has(f.code)) groups.set(f.code, []);
    groups.get(f.code).push(f);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

export function renderConvert(r, { outDir, wrote } = {}) {
  const out = [];
  const rule = '─'.repeat(72);
  out.push('');
  out.push(`  NEO     ${r.intake.root}`);
  out.push(`  schema  ${r.cfg.schema || '(unknown)'}    app  ${r.cfg.apps.join(', ') || '(none)'}`);
  if (outDir) out.push(`  output  ${outDir}${wrote ? '' : '   (dry run — nothing written)'}`);
  out.push('');
  out.push(`  ${rule}`);
  out.push('  WOULD EMIT');
  out.push('');
  const ROLE = {
    calcview: '.hdbcalculationview',
    tablefunction: 'TABLE_FUNCTION_*.hdbfunction',
    cdsproxy: 'db/cds proxy .cds',
    procedure: '.hdbprocedure',
    servicecds: 'service.cds',
    servicejs: 'service.js',
  };
  for (const [role, n] of Object.entries(r.stats.byRole).sort((a, b) => b[1] - a[1])) {
    out.push(`    ${num(n, 5)}  ${ROLE[role] || role}`);
  }
  out.push(`    ${num(r.stats.total, 5)}  total`);
  out.push('');

  if (r.renames.length) {
    out.push(`  ${rule}`);
    out.push(`  RENAMED IDENTIFIERS — ${r.renames.length}   (hand this table to the UI team)`);
    out.push('');
    for (const x of r.renames) out.push(`    ${pad(x.from, 26)} -> ${pad(x.to, 26)} ${x.sites.length} site(s)`);
    out.push('');
  }

  const sorted = [...r.findings].sort(
    (a, b) => (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9) || a.code.localeCompare(b.code),
  );
  const blocked = sorted.filter((f) => f.level === 'blocked');
  const warnings = sorted.filter((f) => f.level !== 'blocked');

  if (blocked.length) {
    out.push(`  ${rule}`);
    out.push(`  BLOCKED — ${blocked.length}`);
    out.push('');
    // Grouped like the warnings below. One cause routinely accounts for
    // thousands of these — printing every one in full buries the others and
    // scrolls the summary off the terminal, which is where the reader was
    // told to look.
    for (const [code, list] of byCode(blocked)) {
      out.push(`    ${num(list.length, 4)}  ${code}`);
      for (const l of wrap(list[0].message, 62)) out.push(`          ${l}`);
      if (list[0].fix) for (const l of wrap(list[0].fix, 62)) out.push(`          ${l}`);
      if (list.length > 1) out.push(`          … and ${list.length - 1} more`);
      out.push('');
    }
  }

  if (warnings.length) {
    out.push(`  ${rule}`);
    out.push(`  WARNINGS — ${warnings.length}`);
    out.push('');
    for (const [code, list] of byCode(warnings)) {
      out.push(`    ${num(list.length, 4)}  ${code}`);
      for (const l of wrap(list[0].message, 62)) out.push(`          ${l}`);
      if (list.length > 1) out.push(`          … and ${list.length - 1} more`);
      out.push('');
    }
  }

  if (wrote) {
    out.push(`  ${rule}`);
    out.push(`  WROTE ${wrote.written} files (${(wrote.bytes / 1024).toFixed(0)} KB) to ${outDir}`);
    out.push('');
  }
  return out.join('\n');
}
