# Plan — neo-to-cf-migrator

`neo2cf <neo-folder> -o <out-folder>` → a CAP/CF tree mirroring NEO's structure,
plus a report. Two modes: deterministic, and deterministic + AI.

Decisions: [`../SESSION-CONTEXT.md`](../SESSION-CONTEXT.md) §2.
Evidence: [`UNDERSTANDING.md`](UNDERSTANDING.md) · [`CONVERSION-STRATEGY.md`](CONVERSION-STRATEGY.md).

Built **fresh** in this folder (D4), copy-pasting proven source from
`C:\Sodales\Tools\migration-cleanup-toolkit`.

---

## 1. The shape of the problem, in numbers

Corpus A, 848 NEO files:

| | Files | How |
|---|---:|---|
| Calc views | 454 | **Deterministic** — 1:1:1:1, 100% pure-script |
| Procedures | 169 | **Deterministic** — copy + 7 SQL fixes |
| `.xsodata` | 21 | **Deterministic** — measured fully derivable |
| **JS (`.xsjs` + `.xsjslib`)** | **88** | **Three tiers — the real work** |
| Out of scope (D6/D7) | 116 | Inventoried, not converted |

And inside those 88 JS files:

| | |
|---|---:|
| Files touching the DB | **73 of 88 (83%)** |
| `prepareStatement` sites | **505** |
| `prepareCall` (stored proc) | 225 |
| `setX(i,v)` binds — all positional | 1,283 |
| `getX(N)` — positional | **897** |
| `getX("name")` — by name | **0** |
| SQL built by concatenation | 109 |

**The JS problem is the DB problem, 505 times.** Everything else in those files
is a closed set of ~15 `$.` idioms with known targets.

---

## 2. Architecture

```
neo-to-cf-migrator/
  bin/neo2cf.js              CLI — arg parsing and rendering ONLY
  src/
    index.js                 programmatic API: run(opts) -> {results, findings, patches}
    core/
      config.js              JSON-Schema-validated; no project literals in code
      intake.js              discoverSections(NEO_ROOT) — classify by extension, never by name
      finding.js             {severity, rule, file, message, fix, evidence}
      patch.js               every change is a reviewable patch, never a silent write
      events.js              event bus — the UI boundary
      fsguard.js             read-only enforcement on the NEO tree, in code
      layout.js              NEO path -> CF path mapping
      naming.js              flatten, numeric-leading renames
    parse/
      calcview.js  xsodata.js  sqlscript.js  xml.js      ← copy from toolkit
      xsjs.js                  acorn AST + $ idiom recognition   ← NEW
    emit/
      hdbcalcview.js  hdbfunction.js  cdsproxy.js  servicecds.js  ← copy from toolkit
      servicejs.js  handler.js                                    ← NEW
    transform/
      db.js                  ★ the JDBC collapse — the centrepiece
      idioms.js              the other ~14 $. idioms
      sqlfixes.js            checklist items 8/12/21/22/23/24/25
      asyncprop.js           async/await propagation over the call graph
    ai/
      index.js               backend registry
      none.js  claude.js  openai.js
      tasks.js  triage.js    ← copy from toolkit
    validate/                checklist assertions over OUTPUT
    report/
  score/compare.js           the scorecard
  test/
```

**Node.js, ESM.** One real dependency: `acorn`. Everything else is stdlib.

### CLI now, UI later (D5)

The rule that keeps this true: **only `bin/neo2cf.js` and `src/report/` may write
to a terminal.** `src/index.js` returns data and emits events. A UI later
subscribes to the same events and renders the same findings. This is the toolkit's
own "UI boundary" discipline, and it costs nothing to keep from day one.

```bash
neo2cf <neo-dir> -o <out-dir>              # dry run — default
neo2cf <neo-dir> -o <out-dir> --write
neo2cf <neo-dir> -o <out-dir> --ai claude
neo2cf inventory <neo-dir>                 # what's there, converted nothing
neo2cf score <neo-dir> --expect <cf-dir>   # the scorecard
```

### Golden constraints (adopted verbatim from the toolkit)

1. Never write to the NEO tree.
2. Dry-run is the default; `--write` is explicit.
3. Every change is a reviewable patch.
4. NEO is the source of truth.
5. **A rule that cannot decide deterministically emits a finding, not a guess.**

---

## 3. Pipeline

Dependency order: procedures → functions → views → services. Parents first.

| # | Pass | no-AI | with-AI |
|---|---|---|---|
| 0 | **Intake** — classify by extension, derive sections, coordinates, cross-module deps, numeric-leading scan | same | same |
| 1 | **Calc views** → `.hdbcalculationview` + `TABLE_FUNCTION_*` + `.cds` proxy | full | full |
| 2 | **Procedures** → cleaned `.hdbprocedure`; record call path + **OUT-params vs result-set** | full | full |
| 3 | **`.xsodata`** → `service.cds` | full | full |
| 4 | **JS Tier 1** — AST transform of `.xsjs`/`.xsjslib` | full, holes marked | full |
| 5 | **JS Tier 2** — fill holes | `NEEDS REVIEW` markers | model, per function |
| 6 | **Fix pass** over everything emitted | same | same |
| 7 | **Validate** output against the checklist | same | same |
| 8 | **Report** + scorecard | same | same |

Pass 2 feeds pass 4: the procedure signatures gathered in pass 2 are what settle
checklist item 16 in pass 4, deterministically.

### `.xsjs` placement — settled by evidence, not guesswork

35 of Corpus A's 60 `.xsjs` survived into CF, and every one landed at:

```
<APP>/<MOD>/<SUB>/Services/X.xsjs  →  srv/lib/<SCHEMA>/<APP>/<MOD>/<SUB>/Services/handlers/X.js
```

A `.xsjs` becomes **its own handler file**, mirroring the NEO path. It does *not*
fold into the service layer. This matches migration-kb's documented mapping.

The 25 that did not survive were `JB_DATAMIGRATION` (a whole module dropped),
root-level table tooling, and `test`/`test2`/`test1234` scratch files. **The tool
converts everything it is pointed at and reports;** excluding a module is the
user's call via config, never the tool guessing.

`.xsjob` is out of scope (D6), but its `action` field —
`PACKAGE:FILE.xsjs::functionName` — names the entry function of a `.xsjs`. Parse
`.xsjob` **for that fact only**, so the right function gets exported.

---

## 4. The centrepiece: `transform/db.js`

505 sites. Recognise the chain by **data flow, not text**:

```
$.db.getConnection()  →  conn
conn.prepareStatement(q) | conn.prepareCall(q)  →  stmt
stmt.setX(i, v) ...                             →  binds, ordered by i
stmt.executeQuery() | executeUpdate() | execute()→  rs
while|if (rs.next()) { ... rs.getX(N) ... }     →  reads, by ordinal
```

Emit:

```js
const rows = await cds.run(`<sql>`, [<binds in order>]);
```

Then resolve reads. This is the part that only a parser can do correctly:

- **`getX(N)` → column name** by parsing the SELECT list of `q` and taking the
  Nth output column (its alias if it has one, else the expression). 897 sites,
  none of them by name.
- **Array vs object** — `SELECT` → array (`rows[0].COL`); `CALL` with OUT params
  → object (`res.OUT_X`). The proc signature comes from pass 2. This is checklist
  item 16, decided from a fact rather than remembered.
- **`while (rs.next())`** → `for (const row of rows)`; **`if (rs.next())`** →
  `if (rows.length)` + `rows[0]`.
- `commit`/`close` → dropped (CAP manages the transaction); `rollback` → `req.reject`
  or an explicit `cds.tx` — only 2 sites, handle by hand.

**Holes** (become Tier 2 work, ~109 + 10 sites):

- SQL assembled by concatenation — the string is not statically known
- dynamic table names
- a `getX(N)` whose `N` exceeds the parsed SELECT list, or a `SELECT *`
- any chain whose `stmt` alias escapes the function

Each hole records: the NEO excerpt, the reason, the surrounding converted code.

**This transform is the highest-risk, highest-value module in the tool.** It gets
its own test file with real fixtures pulled from the corpus, and it is worth
writing before anything else in the JS tier.

---

## 5. The AI tier

Only what Tier 1 refused. Never a whole file.

**Unit = one function.** Prompt:

```
SYSTEM   the migration rules (fixed, cacheable)
FACTS    resolved imports · real table names · procedure signatures
         (OUT-params vs result-set) · the function's call sites
NEO      the original function, verbatim
PARTIAL  what Tier 1 produced around the hole
ASK      "return only the body of function X"
```

**Deterministic gate on the way back** — parses · no surviving `$.` · same
name/arity · every import resolves to a real emitted file · no invented table
names · SQL passes the same checks as Tier 1. Fail → retry once with the failure
attached → fail again → Tier 3 (human).

The model never writes a file. It returns a proposal that the pipeline validates.

**Backends** — one interface, three implementations:

| Backend | How |
|---|---|
| `none` | Skeleton + `NEEDS REVIEW`. Never guesses. |
| `claude` | `claude -p "<prompt>" --output-format json --append-system-prompt <rules> --allowed-tools "" --model <m>` |
| `openai` | On-prem, `POST {baseUrl}/chat/completions` |

`--allowed-tools ""` matters: pure text transform, no filesystem access, cannot
touch the reference codebases.

---

## 6. The scorecard

```
neo2cf score TECK-neo-code --expect neo-to-cf-teck-jbd-backend
```

One percentage per artifact type, structural comparison (path, entity name,
column set, `srv.on` aliases) — not textual. It is how "most possible success
rate in both modes" stops being a feeling.

Three exclusions it must implement, or it lies:

1. **Files with no NEO ancestor** — ValidationUtil, Middleware, rateLimitChecker,
   sweepGuard, hanaIdentifier, roleCheckAccess, custom-service, datapull-service,
   and the role-assignment set. Per D8 the tool should not emit them.
2. **`NEO_DRIFTED` views** — NEO was refreshed 2026-08-11; 8 of 27 migrated views
   no longer match, every one a genuine NEO change. **The hand-migrated CF is a
   2026-08 snapshot, not ground truth.**
3. **Known reference defects** — the item-16 bugs in `TECK_HR_Notes.js`. If the
   tool emits the *correct* `rows[0].USERCOUNT`, a naive scorer calls it a
   mismatch.

---

## 7. Build order

| Phase | Ships | Why here |
|---|---|---|
| 1 | Core skeleton + intake + `inventory` command + scorecard shell | Baseline of 0%. Proves section discovery from NEO, which is the thing the toolkit could not do. |
| 2 | Calc views (pass 1) + fix pass + validate + report | 454 files — 62% of in-scope — and it exercises the whole pipeline end to end. |
| 3 | Procedures (pass 2), incl. OUT-param signature capture | +169 files, and it is a prerequisite for phase 5. |
| 4 | `.xsodata` → `service.cds` (pass 3) | +21. Everything deterministic is now done. |
| 5 | **`transform/db.js`** + the other idioms + async propagation | The 505 sites. The hard part, with its own fixtures. |
| 6 | JS emit + holes + `NEEDS REVIEW` | **No-AI mode complete. Score it.** |
| 7 | AI adapter + `claude` backend, function-level, gated | Now measurable against phase 6's number. |
| 8 | `openai` backend for the on-prem model | Config only. |

Phase 2 is the first release that produces real output. Phase 6 is the first
honest no-AI number. Phase 7 is the first honest answer to "is the model worth
it".

---

## 8. What to copy from the toolkit

Proven, tested, zero-dependency source. Copy and adapt; do not re-derive.

| Take | For |
|---|---|
| `src/parsers/` — calcview, xsodata, sqlscript, xml, xsjslib | The parsers are the expensive part |
| `src/generator/` — cdsproxy, hdbfunction, hdbprocedure, servicecds | Generation from NEO, already validated 587/587 |
| `src/generator/handlerimports.js`, `resolve.js` | Deterministic import resolution — Tier 1 needs exactly this |
| `src/core/fsguard.js`, `finding.js`, `patch.js`, `events.js` | The constraints and the UI boundary |
| `src/ai/provider.js`, `tasks.js`, `triage.js` | Adapters + the disposition table |
| `research/scan-drop-shapes.js` | Classify folders by extension, never by name |

**Do not take** its `discoverSections(dropPath, cfg)` — we root at NEO. And its
`01-goals.md` premise ("this is not a from-scratch migration tool") is exactly
what we are inverting.

---

## 9. Open questions

1. **On-prem model** — endpoint, model name, context window. Function-level was
   chosen partly to keep prompts small, but the number decides batching.
2. **Numeric-leading rename scheme** — needs team sign-off; these are OData names
   the UI calls.
3. **Association naming** — corpus splits 3 sections to 3; wrong choice fails at
   runtime with no build error. Human decision.
4. **Parameterized views** (222 of 587) — flagged by the toolkit as the
   highest-risk generated artifact, never verified against a live deploy.
5. **Procedures 169 → 157** in Corpus A, undocumented. Carry all, flag the delta.
6. ~~`SELECT *` blocking positional resolution~~ — **closed by measurement.**
   Only **4** `SELECT *` in the whole Corpus A corpus against **446** explicit-column
   SELECTs. Positional `getX(N)` resolves for ~99% of queries. The 4 become holes.
