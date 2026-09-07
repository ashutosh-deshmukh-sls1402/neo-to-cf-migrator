# Architecture — how the tool works

For a developer who has to change it. Read this once, top to bottom; it follows
one `convert` run from the command line to the written tree.

Companion docs: [`USAGE.md`](USAGE.md) for running it,
[`CONVERSION-STRATEGY.md`](CONVERSION-STRATEGY.md) for *why* each artifact
converts the way it does, [`../SESSION-CONTEXT.md`](../SESSION-CONTEXT.md) §0 for
current numbers and the build log.

---

## 1. The five rules everything obeys

Break one of these and something downstream breaks silently. They are not
style preferences; each was learned from a specific bug.

| # | Rule | Why |
|---|---|---|
| 1 | **Never write to the NEO tree.** Enforced in `core/write.js`, not by convention. | NEO is the input and the only source of truth. |
| 2 | **Dry run is the default.** `--write` is explicit; a blocker stops it unless `--force`. | A partially converted tree that looks complete is worse than none. |
| 3 | **A rule that cannot decide deterministically emits a finding, not a guess.** | The whole tool's credibility. A refusal costs a developer ten minutes; a wrong conversion costs a day and may never be found. |
| 4 | **The AST locates; the original text is edited by offset.** JavaScript is never regenerated from the parse tree. | Regenerating reformats every file and drops every comment, leaving nothing to diff against NEO. |
| 5 | **Only `bin/` and `src/report/` may write to a terminal.** Everything else returns data. | A UI later is a rendering job, not a rewrite. |

A sixth, narrower rule matters whenever you touch the JavaScript tier:
**all passes contribute edits to one `applyEdits` call.** That is what makes two
transforms claiming the same bytes an error instead of one quietly winning.

---

## 2. The map

```
bin/neo2cf.js          argument parsing and rendering. No behaviour.
  │
  ├─ src/index.js          inventory()  — survey a tree, convert nothing
  ├─ src/convert.js        convert()    — THE PIPELINE (§3)
  ├─ src/transform/scan.js scanDb()     — dbscan: how much JS converts
  └─ score/compare.js      score()      — emitted paths vs a hand-migrated tree

src/core/       what a NEO tree *is*
  artifacts.js    extension → kind. Folders classified by contents, never by name
  intake.js       discover(): units, schema, <APP> segments, warnings
  config.js       format defaults only — never project values
  layout.js       NEO path → CF path, and ESM import specifiers
  naming.js       calc-view name flattening, numeric-leading renames
  write.js        the two write guards (rules 1 and 2)

src/parse/      NEO formats → data
  calcview.js     .calculationview (XML) → scenario, nodes, SQLScript, attributes
  sqlscript.js    a SQL-aware scanner: strings, comments, quoted identifiers
  xsodata.js      .xsodata grammar → entities, keys, with(), navigates, create using
  procsig.js      .hdbprocedure signatures → parameter names and IN/OUT modes

src/transform/  the JavaScript tier — one NEO .xsjs/.xsjslib in, one CF handler out
  file.js         composes every pass over ONE parse; owns applyEdits + re-parse
  js.js           parse / walk / parentMap / applyEdits   (the substrate)
  db.js           JDBC chain ANALYSIS — facts and gaps. Emits nothing
  emitdb.js       renders a resolved chain as await cds.run(…)
  imports.js      $.import + its reference → one ES import
  request.js      $.request / $.response / $.session, the entry function, the export
  http.js         $.net.http / $.web.WebRequest → executeHttpRequest

src/emit/       data → CF file text
  hdbfunction.js  TABLE_FUNCTION_*.hdbfunction from the calc view's SQLScript
  hdbcalcview.js  .hdbcalculationview — a projection over that function
  cdsproxy.js     db/cds/*.cds — the CAP entity over the deployed view
  servicecds.js   service.cds from the .xsodata
  servicejs.js    service.js — the handler wiring
  project.js      package.json, mta.yaml, srv/index.cds, xs-security.json, db/
  awaits.js       cross-file await propagation over the whole emitted tree

src/ai/         Tier 2 — the only non-deterministic code in the tool
  backend.js      the only subprocess: --ai claude | cmd:<runner>
  tasks.js        the task registry: prompt, parse, validate
  index.js        the driver: ask → re-analyse → accept or discard

src/report/render.js   every line of terminal output
checks/                measurements that need a real corpus (§7)
test/                  264 tests, no framework
```

---

## 3. One `convert` run, end to end

```
neo2cf convert <neo-dir> -o out --write
        │
        ▼
  INTAKE ── discover(): what is in this tree?
        │
        ▼
  PHASE A ── parse every file into data
        │
        ▼
  PHASE B ── resolve names (proxy entity names, CF paths)
        │
        ▼
  PHASE C ── emit file text, artifact by artifact
        │
        ▼
  WHOLE-TREE ── cross-file awaits, then the project shell
        │
        ▼
  WRITE ── guards, then files land in out/
```

### Intake — `core/intake.js`

Walks the tree and returns **units**: a folder plus the files in it plus a
*kind*. The kind comes from the extensions inside the folder, never its name —
the corpus has `Views` and `View` as distinct real folders, `.xsodata` living in
a dozen differently-named folders, and `Library` folders holding three different
extensions. Any rule keyed on folder names matches the wrong folder somewhere.

Intake also infers two things it cannot be given:

- **the schema** — the first segment of `$.import` package paths, with the
  evidence count kept so `inventory` can show the runners-up;
- **the `<APP>` segment(s)** — which matter because `db/` paths drop them and
  `srv/lib` keeps them.

When it cannot infer one, it says so (`inventory` prints the warning) rather
than picking. A wrong `<APP>` silently merges unrelated subtrees.

### Phase A — parse

Each unit's files go to the parser for their kind, producing plain data:
calc-view scenarios, `.xsodata` entity lists, procedure signatures, and the raw
text of `.xsjs`/`.xsjslib` (which is parsed later, in Phase C, because the JS
tier needs one parse shared by every pass).

One piece of information flows **backwards** here, and it is why parse and emit
are separate phases at all: a CDS proxy's `key` columns are declared in the
`.xsodata` that projects the view, not in the view. Emitting while walking would
mean either a missing key or a forward reference.

### Phase B — resolve names

Calc views get their CF identity: the flattened entity name
(`TECK.JB.Views::V` → `TECK_JB_VIEWS_V`), the table-function name, and the
`db/cds` file path. These go into a `proxies` map keyed by the NEO id
(`namespace::filename`) — the id an `.xsodata` refers to, which for 92 views in
the corpus is *not* the scenario id inside the XML.

### Phase C — emit

| NEO input | CF output | Emitter |
|---|---|---|
| `.calculationview` | `db/src/…/X.hdbcalculationview` (a projection) + `db/src/…/TABLE_FUNCTION_X.hdbfunction` (the SQLScript) + `db/cds/…/ENTITY.cds` (the CAP proxy) | `hdbcalcview`, `hdbfunction`, `cdsproxy` |
| `.hdbprocedure` | `db/src/…/same-name` — copied, with the same SQL hygiene | inline |
| `.xsodata` | `srv/lib/<SCHEMA>/…/service.cds` + `service.js` | `servicecds`, `servicejs` |
| `.xsjs` / `.xsjslib` | `srv/lib/<SCHEMA>/…/handlers/X.js` | `transform/file.js` |

Two path asymmetries, both verified against a shipped CF tree and both easy to
get wrong (`core/layout.js`):

- **`db/src` and `db/cds` DROP the `<APP>` segment.**
- **`srv/lib` KEEPS it,** under `srv/lib/<SCHEMA>/`.

`.xsodata` files in the same folder are merged into **one** `service.cds` with
one deduplicated `using` header, because two services in one folder would
otherwise fight over the same file name. CAP service names are global, so
colliding names are qualified by the first differing folder segment.

### Whole-tree passes

Two things are impossible to see one file at a time, so they run after
everything is emitted:

1. **`emit/awaits.js`** — cross-file `await`. The per-file pass makes a function
   `async` and can only print "callers in other files must await these". This
   builds one call graph over the whole emitted tree, runs a fixed point (a call
   to an async function needs `await` → its container is async → so are *its*
   callers), splices the edits, and re-parses every file it touched. On the two
   corpora it added 1,275 awaits. Without it they were 1,275 latent
   fail-silently bugs.
2. **`emit/project.js`** — the project shell, last because what it declares
   depends on what the run produced (the destination service only exists if a
   destination call was actually converted).

### Write — `core/write.js`

Refuses if the output directory is inside the NEO tree (rule 1). Refuses if any
finding is `blocked` and `--force` was not given (rule 2). Then writes.

---

## 4. The JavaScript tier in detail

This is the hardest part of the tool and where most changes will land.
`transform/file.js` parses the file **once** and hands the same AST to every
pass. Each pass returns *edits* — `{start, end, text}` offsets into the original
source — and they are spliced together at the end.

### Pass order, and why it is not arbitrary

```
imports  →  request  →  http  →  db  →  (async)  →  applyEdits  →  re-parse
```

A pass that **moves** text must run after the passes that rewrite *inside* what
it moves, and must replay those rewrites into the copy (`ctx.inlineRewrites`).
The two movers are `http` (a header value leaves its setter) and `db` (a bind
value leaves its `setNString(…)` and lands inside `cds.run`'s array). Get this
wrong and the failure is silent: the moved copy simply keeps the old `$.` idiom.

The matching rule for authors: **rewrite *around* a sub-expression, never over
it.** A pass that replaces a whole statement locks every other pass out of its
interior. `request.js` therefore emits *pairs* of edits bracketing the argument
it keeps.

### `db.js` — analysis only

The highest-value module in the tool, and it emits nothing. It turns this

```js
conn  = $.db.getConnection();
q     = 'SELECT A, B FROM T WHERE C = ?';
pstmt = conn.prepareStatement(q);
pstmt.setNString(1, x);
rs    = pstmt.executeQuery();
while (rs.next()) { out.push(rs.getNString(1)); }
```

into one **chain** object: the SQL (resolved through variables), the binds in
index order, the columns the SELECT projects, where the rows are read, the loop
shape — and a `gaps` list of anything it could not decide. `resolved` is simply
"no gap that is not a note".

Three consumers read the same chain: the emitter, the report, and the AI tier.
That is why analysis and emission are separate files.

Things it deliberately refuses, each with its own code: SQL assembled at run
time, a bind index that is computed, a column read where the row no longer
exists, a `getX(i)` with a computed index, a JDBC ResultSet method CAP does not
have. `checks/ceiling.js` tells you what fixing any one of them is *worth*.

### `emitdb.js` — rendering only

Takes a resolved chain and produces the edits. It never re-derives a column name
or a bind order. If `db.js` did not resolve a chain, this leaves the NEO code
exactly as it found it under a `NEEDS HUMAN REVIEW` banner listing every reason.

### The re-parse gate

`transform/file.js` re-parses its own output as an **ES module** and refuses the
result if it does not load. `convert` does the same for the `service.js` it
authors. This has caught real bugs repeatedly; note that `node --check` is not
equivalent — it treats a file as a script, where XSJS-isms still pass.

---

## 5. Tier 2 — the AI tier (`--ai`)

Off by default. Tier 1 is byte-identical in both modes, which is enforced by
construction: **Tier 2 has no emitter.**

```
analyse  →  ask about what Tier 1 refused  →  ANALYSE AGAIN  →  emit
```

The second analysis is the whole design. A model's answer is fed back in as an
*input to Tier 1*, which then decides using every check it already applies. If
the statement still does not resolve, the answer is discarded and the developer
sees the original refusal, unchanged. The worst a wrong answer can do is waste a
call.

Rules for adding a task to `src/ai/tasks.js`:

- **Ask for an answer, never for code.** The one shipped task returns one word
  per interpolated SQL value: `value` / `list` / `identifier` / `unknown`.
- **Never ask about what Tier 1 can decide**, and never about a statement with a
  second blocker — the answer would convert nothing (the ceiling rule).
- **Validate something semantic.** Never "it parsed". The shipped validator uses
  the SQL grammar to overrule the model: a hole after `FROM` cannot be a bind
  parameter; a hole after `=` cannot be an identifier.
- **`unknown` is a real answer** and is recorded as one. "The model declined" and
  "the model was never asked" are different facts.

Anything a model decided is marked `AI-CLASSIFIED` **in the emitted file**, not
only in the report — the report is not there when someone reads the code later.

---

## 6. Findings — the other half of the output

Every refusal is a finding, and findings are as much the deliverable as the
code. Three levels:

| Level | Meaning | Effect |
|---|---|---|
| `note` | true about a statement that **did** convert, and the reader needs to know | none |
| `warning` | something was not converted, or was converted with a caveat | reported |
| `blocked` | the output is not safe to hand over | stops `--write` unless `--force` |

A finding carries `code`, `message`, usually `file`, and — where one exists — a
`fix` that tells the developer what to change in NEO so the tool can convert it
on the next run. That last field is the difference between a report and a
to-do list.

---

## 7. How to verify a change

One command, ten steps, non-zero exit if any fails:

```bash
npm run verify -- <neo-dir> [<neo-dir> …] --expect <hand-migrated-cf> --cds <path-to-cds>
```

It runs the tests, converts each corpus, then five checks that need no reference
tree:

| Check | Asks |
|---|---|
| `checks/emitted.js` | does every introduced variable exist and is it in scope; does every emitted `.js` parse |
| `checks/leaks.js` | what is left of the `$.` surface, and **does every remaining site sit in a file that carries a finding** |
| `checks/awaits.js` | is every cross-file call to an async function awaited |
| `checks/ceiling.js` | what is each refusal actually worth (chains where it is the *only* blocker) |
| `cds build --production` | **the only real oracle** — what CAP itself accepts |

The last one has found defects nothing else could see, five of them the first
time it was run. Run it after any change to a `.cds` emitter.

`checks/ceiling.js <neo> --code SQL_DYNAMIC` is the tool to reach for before
building anything for a bucket of refusals: it prints the statements that one
fix would convert. Four times running it has replaced planned work with
something smaller and deterministic.

---

## 8. Where to make a change

| You want to… | Go to |
|---|---|
| support a new NEO extension | `core/artifacts.js`, then a parser and an emitter |
| change where a file lands | `core/layout.js` — and re-run `score` |
| convert more JDBC statements | `transform/db.js` (analysis), never `emitdb.js` |
| change generated SQL hygiene | `emitdb.js: cfSql()` and `parse/sqlscript.js` |
| handle another `$.` idiom | the pass that owns it; add to the leak check's expectations |
| add an AI task | `src/ai/tasks.js` — read §5 first |
| add a project-shell file | `emit/project.js` (and remember rule: only what NEO has) |

Two habits that keep the tool honest:

1. **Measure before building.** `checks/ceiling.js` and `dbscan` exist for this.
2. **Read the output of the statements your change just unblocked.** A refusal
   hides everything downstream of it; three real bugs were found exactly this
   way.
