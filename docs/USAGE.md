# Usage guide

Everything the tool can be asked to do, in the order you would actually do it.

For how it works internally, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 0. Install

```bash
cd C:/Sodales/Tools/neo-to-cf-migrator
npm install          # two runtime dependencies: acorn, fast-xml-parser
node test/run.js     # 264 tests, ~2s. Run this first, once.
```

Node 18+. Nothing else is required — no HANA, no CF account, no model.

`npx cds build` needs `@sap/cds-dk`, which this repo deliberately does not
install; §5 shows how to point at any existing copy of it.

---

## 1. The five-minute workflow

```bash
NEO=C:/path/to/neo-codebase
OUT=C:/path/to/output          # anywhere OUTSIDE the NEO tree

node bin/neo2cf.js inventory $NEO             # 1. what is in here?
node bin/neo2cf.js dbscan    $NEO             # 2. how much of the JS converts?
node bin/neo2cf.js convert   $NEO -o $OUT     # 3. dry run — read the findings
node bin/neo2cf.js convert   $NEO -o $OUT --write   # 4. write it
cd $OUT && npm install && npx cds build --production   # 5. does CAP accept it?
```

Steps 1–3 write nothing anywhere. Step 4 writes only into `$OUT`, and refuses if
`$OUT` is inside the NEO tree. **The NEO tree is never modified, by any command,
ever.**

---

## 2. The commands

### `inventory` — survey, convert nothing

```bash
node bin/neo2cf.js inventory <neo-dir> [--schema X] [--app A,B] [--json]
```

Answers "what am I dealing with, and does the tool understand this tree?"

```
  NEO tree   C:\…\neo-code
  Schema     TECK   inferred from $.import statements
  App(s)     JOB_BIDDING   inferred

  CONVERTIBLE
      454  calculation views
      169  procedures
       19  OData services (.xsodata)
       88  JS libraries/services

  NOT CONVERTED — recognised, deliberately out of scope
       12  .xsjob               scheduling, no CAP equivalent in scope
  …
  UNRECOGNISED — no rule for these, they will be ignored
```

**Read the warnings at the top first.** If the schema or the `<APP>` segment
could not be inferred, the tool says so instead of picking one — pass
`--schema`/`--app`, because a wrong `<APP>` silently merges unrelated subtrees.
`UNRECOGNISED` is worth a glance: those files are ignored entirely.

### `dbscan` — how much of the JavaScript converts

```bash
node bin/neo2cf.js dbscan <neo-dir> [--ai <backend>] [--json]
node bin/neo2cf.js dbscan <neo-dir> --show <rel/path/File.xsjs>
```

The JS tier is where migrations are won or lost, so this exists to tell you
before you start. It converts nothing to disk.

```
  JDBC STATEMENTS — 673
      655  converted automatically   97.3%
       18  need a decision this tool will not make for you

      119  $.import(…) resolved to ES imports
       21  request entry points found and exported as the default
       85  files rewritten, of which 84 produce loadable JavaScript

  CONVERTED, BUT WORTH READING
      251  SQL_IDENTIFIER_INTERPOLATED  a table or column name is written into the SQL…

  WHY THE REST NEED A DECISION
        6  NO_EXEC                  prepared and never executed — dead code, or a bug
        4  SQL_DYNAMIC              the SQL string is assembled at run time

  FILES TO LOOK AT FIRST
        2 of 48   Env_Config/TECK_DyanamicRoleAssignmrnt.xsjs
```

Three sections, three different meanings:

- **CONVERTED, BUT WORTH READING** — these statements *did* convert. The note
  tells you something true about the result that you should check (most often:
  a table name was written into the SQL text because SQL cannot bind an
  identifier).
- **WHY THE REST NEED A DECISION** — refusals, by reason. Nothing was guessed.
- **FILES TO LOOK AT FIRST** — refusals per file, worst first. This is your
  review queue.

`--show <rel-path>` converts **one** file and prints it to stdout, with the
notes on stderr. This is the fastest way to see what the tool does to a
particular file without writing anything:

```bash
node bin/neo2cf.js dbscan $NEO --show Library/CommonUtil.xsjslib | less
```

### `convert` — produce the CF tree

```bash
node bin/neo2cf.js convert <neo-dir> -o <out-dir> [--write] [--force]
                                     [--schema X] [--app A,B] [--ai <backend>] [--json]
```

Without `--write` it is a **dry run**: it does the entire conversion in memory
and reports what it would write. Do this first and read the findings.

```
  NEO     C:/…/neo-code
  schema  TECK    app  JOB_BIDDING
  output  C:/…/out   (dry run — nothing written)

  ────────────────────────────────────────────────────────
  WOULD EMIT

      454  TABLE_FUNCTION_*.hdbfunction
      454  .hdbcalculationview
      454  db/cds proxy .cds
      169  .hdbprocedure
       87  handler
       19  service.cds
       19  service.js
        6  project
     1662  total

  ────────────────────────────────────────────────────────
  RENAMED IDENTIFIERS — 2   (hand this table to the UI team)

    91Efu5zcsYvGmdP            -> E91Efu5zcsYvGmdP           1 site(s)

  ────────────────────────────────────────────────────────
  WARNINGS — 492

     251  SQL_IDENTIFIER_INTERPOLATED
          …/CommonUtil.xsjslib: `PushEmployeeUserId[v]` is written into
          the SQL text rather than bound: this is DDL, which takes no
          bind parameters.
          … and 250 more
```

**RENAMED IDENTIFIERS matters to more than you.** A NEO name that starts with a
digit is not a legal CDS identifier, so it is renamed — and any UI calling that
entity by name has to be told. The table is printed for exactly that reason.

Exit code is `0` unless there are blockers — including on a dry run — in which
case it is `1` unless `--force` is given.

**Blockers vs warnings.** A blocker means the output is not safe to hand over —
an entity projecting a view that does not exist in this tree, a generated
`service.js` that does not parse. A warning means something was not converted,
or was converted with a caveat you should read. `--force` writes anyway; use it
knowingly.

### `score` — check the emitted paths against a hand-migrated tree

```bash
node bin/neo2cf.js score <neo-dir> --expect <hand-migrated-cf-dir> [--json]
```

Only useful when you have a CF tree someone migrated by hand for the *same* NEO
source. It runs the conversion and compares where files landed:

```
  ROLE                            MADE  EXACT  NAME  GONE  DROP  NONE   HIT
  TABLE_FUNCTION_*.hdbfunction     454    453     1     0     0     0   99.8%
  srv handler .js                   87     57     0     0    30     0  100.0%
  TOTAL                           1656   1610                       1   99.9%
```

`EXACT` = a file exists at exactly the path we wrote. `NAME`/`GONE` mean the
naming or path rule is off — those are bugs. `DROP` = the hand migration did not
carry that NEO file across at all (their decision, not scored). **`NONE` = a NEO
file we produced nothing for** — the only column that is unambiguously ours.

---

## 3. Reading the output tree

```
out/
  db/
    src/…      .hdbcalculationview, TABLE_FUNCTION_*.hdbfunction, .hdbprocedure
    cds/…      one .cds proxy entity per calculation view
    package.json, undeploy.json
  srv/
    lib/<SCHEMA>/…/service.cds     the CAP service
    lib/<SCHEMA>/…/service.js      handler wiring: srv.on(alias) → the function
    lib/<SCHEMA>/…/handlers/*.js   one per NEO .xsjs / .xsjslib
    index.cds                      CAP does not walk srv/lib on its own
  package.json, mta.yaml, xs-security.json
```

The folder structure mirrors NEO, with two deliberate asymmetries:
**`db/` drops the `<APP>` segment; `srv/lib` keeps it**, under the schema name.

### The markers to grep for

```bash
grep -rn "NEEDS HUMAN REVIEW" out/srv     # every refusal, in place, with reasons
grep -rn "AI-CLASSIFIED"      out/srv     # every statement a model decided (§4)
```

A refusal is left as the original NEO code with the reasons directly above it:

```js
// NEEDS HUMAN REVIEW — this database call was not converted.
//   SQL_DYNAMIC: The SQL is built at run time (string concatenation with a
//     run-time value), so its columns and parameter count cannot be read here.
//     Convert this statement by hand, or make the SQL a static string with ?
//     parameters.
var pstmt = conn.prepareStatement(query);
```

Note the last line of each: where a fix exists, the tool tells you what to
change **in NEO** so the next run converts it automatically. On a large tree
that is often faster than converting by hand.

---

## 4. AI mode (optional)

```bash
node bin/neo2cf.js convert $NEO -o $OUT --write --ai claude
node bin/neo2cf.js convert $NEO -o $OUT --write --ai "cmd:ollama run qwen2.5-coder:7b"
node bin/neo2cf.js dbscan  $NEO --ai claude          # see what it would settle
```

| `--ai` value | Backend |
|---|---|
| `none` (default) | no model; deterministic tier only |
| `claude` | the `claude` CLI, headless (`claude -p`) |
| `cmd:<command>` | any command that reads a prompt on stdin and writes to stdout |

What it does, and does not:

- It is asked **only** about statements Tier 1 refused *and* that one answer
  would convert. On a 1,796-statement corpus that was 16 calls.
- It answers a **question**, never code — one word per interpolated SQL value.
  The conversion is then done by the same deterministic code as everything else.
- Its answer is re-checked by the full analysis. If the statement still does not
  resolve, the answer is dropped and you see the original refusal.
- Everything it settled is marked `AI-CLASSIFIED` in the emitted file.

The report gains a section telling you exactly what happened:

```
  TIER 2 — what the model was asked

       16  statement(s) asked about — only those one answer would convert
       16  answered, checked, and converted
```

Deterministic mode is not a degraded mode: it converts ~96% of JDBC statements
on both reference corpora with no model at all.

---

## 5. Verifying the output

### The one that matters most

CAP's own compiler is the only thing that knows what CAP accepts:

```bash
cd $OUT && npm install && npx cds build --production
```

If `@sap/cds-dk` is not installed, any existing CF project has a copy:

```bash
CDS=/path/to/some-cf-project/node_modules/.bin/cds
(cd $OUT && "$CDS" build --production)
```

Expect `0 errors, 0 warnings`. The first time this was ever run it found five
defects nothing else could see, including a CDS type that does not exist.

### The whole sweep, one command

For anyone changing the tool:

```bash
npm run verify -- <neo-dir> [<neo-dir> …] \
  --expect <hand-migrated-cf-dir> \
  --cds <path-to-cds>
```

```
  PASS  tests
  PASS  convert <corpus>
  PASS  emitted tree — scope, sentinels, re-parse
  PASS  refusal ceilings
  PASS  $. leaks — every remaining site has a finding
  PASS  cross-file awaits — every async call is awaited
  PASS  score
  PASS  cds build --production  <corpus>
```

Non-zero exit if any step fails. `--no-build` skips the last step;
`--out <dir>` chooses where the conversions land.

Individual checks, all runnable on their own:

```bash
node checks/ceiling.js <neo-dir> [--code SQL_DYNAMIC]   # what a refusal is worth
node checks/leaks.js   <neo-dir>                        # what is left of the $. surface
node checks/emitted.js <out-dir>                        # scope, sentinels, re-parse
node checks/awaits.js  <out-dir>                        # every async call awaited
```

---

## 6. What still needs a human

The tool is explicit about this rather than quiet, and the list is short.

1. **Every refused statement**, in `NEEDS HUMAN REVIEW` blocks. On the reference
   corpora that is 68 of 1,796 — dead code, procedures in a schema the tree does
   not contain, SQL arriving in a request body.
2. **Every `AI-CLASSIFIED` statement**, if you ran with `--ai`.
3. **Interpolated identifiers** (`SQL_IDENTIFIER_INTERPOLATED`). These converted
   correctly and faithfully, but a table name written into SQL text is an
   injection surface if the value can reach a caller. The tool converts what NEO
   did and names the expression; whether that value is reachable is a judgement
   about the whole application.
4. **`xs-security.json` scopes.** Emitted empty because NEO's `.xsprivileges`
   declare only `Execute`. Add real scopes before deploying.
5. **`mta.yaml` foreign-schema resources.** One `existing-service` stub per
   schema the tree reads and does not own, with a TODO placeholder for the real
   service name.
6. **Runtime testing against a real HANA.** `cds build` proves the model
   compiles; it does not run a single SQL statement. Every API needs a manual
   pass — that was always the plan.

---

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot convert without a schema` | Intake could not infer it from `$.import` paths. Pass `--schema <NAME>`. |
| `inventory` warns about the `<APP>` segment | It cannot tell which folder level is the app, and guessing merges unrelated subtrees. Pass `--app A,B`. |
| `Refusing to write into the NEO tree` | `-o` points inside the NEO source. Choose a directory outside it. Working as designed. |
| `N blocker(s) outstanding — nothing was written` | Read them (they are printed above), fix or accept, then `--force` if you want the partial tree anyway. |
| A handler file has no `import cds from "@sap/cds"` | That file has no database access — nothing to import. |
| `DUPLICATE_FUNCTION` and the file does not load | A NEO defect the conversion exposes: the file declares one function twice, which an XSJS script allows and an ES module rejects. Delete the dead declaration in NEO and re-run. |
| `cds build` reports a missing entity | A `.xsodata` projects a calculation view that is not in this tree (`PROXY_NOT_FOUND`). Convert the module that owns it, or drop the entity. |
| `--ai claude` fails with "could not be reached" | The `claude` CLI is not on `PATH`, or not authenticated. The run continues without it; refusals stay refusals. |

---

## 8. Reference: exit codes

| Code | Meaning |
|---|---|
| `0` | success, with no blockers |
| `1` | blockers outstanding (dry run or `--write`, without `--force`), a bad argument, or an unreadable tree |
| `2` | a `checks/*.js` script was called with no arguments |
