# Session context — NEO → CF migrator

**Started 2026-09-05, last worked 2026-09-08.** Everything decided, measured, and
left open. Read §0 first; §§1–10 are the reasoning, §§11–29 the build log.

> **Corpus A** and **Corpus B** are the two real NEO codebases every number
> here was measured against. Their paths are in the command blocks below and in
> §3; the prose names them neutrally so these documents can be shared as they
> are.

| Doc | What |
|---|---|
| `SESSION-CONTEXT.md` | ← you are here. Decisions, measurements, build log |
| `docs/USAGE.md` | **How to run it** — every command, its output, and what to do with it |
| `docs/ARCHITECTURE.md` | **How it works** — the rules, the module map, one `convert` run end to end |
| `docs/UNDERSTANDING.md` | The survey — codebases, counts, prior art, scope |
| `docs/CONVERSION-STRATEGY.md` | **The technical core** — per-artifact strategy, the three tiers, the prompting model, small-model design |
| `docs/PLAN.md` | The original build plan and phase order — historical; `ARCHITECTURE.md` supersedes its pipeline section |

---

## 0. STATUS — start here

**Every artifact type now converts, JavaScript included, and `convert` writes all
of it, with no blockers on either corpus.** 7,959 lines of source, 533 of checks (+3,000 of
tests), **356 tests, 0 failures**, two
runtime dependencies (`fast-xml-parser`, `acorn`).

```bash
node bin/neo2cf.js inventory <neo-dir>                    # survey; converts nothing
node bin/neo2cf.js dbscan    <neo-dir>                    # how much .xsjs DB access converts automatically
node bin/neo2cf.js dbscan    <neo-dir> --show <rel-path>  # convert one file and print it
node bin/neo2cf.js convert   <neo-dir> -o <out> --write   # dry run without --write
node bin/neo2cf.js score     <neo-dir> --expect <cf-dir>  # score the emitted files vs a hand-migrated tree
node bin/neo2cf.js convert   <neo-dir> -o <out> --write --ai claude   # Tier 2 (§28); default is --ai none
node test/run.js                                          # 356 tests, no framework

# all of the above plus the CDS compiler, one command, non-zero exit on failure
npm run verify -- <neo-dir> […] --expect <cf-dir> --cds <path-to-cds>

# or the pieces (see "How to verify a change" below)
node checks/ceiling.js  <neo-dir> [<neo-dir> …]           # what each refusal is worth
node checks/leaks.js    <neo-dir> [<neo-dir> …]           # what is left of the $. surface
node checks/emitted.js  <out-dir> [<out-dir> …]           # scope, sentinels, re-parse
node checks/awaits.js   <out-dir> [<out-dir> …]           # every cross-file async call awaited
cd <out-dir> && npx cds build --production                # the only real oracle
```

### What works

| Artifact | State |
|---|---|
| `.calculationview` → `.hdbcalculationview` + `TABLE_FUNCTION_*.hdbfunction` + `db/cds` proxy | **Done** — 454/454, 98.9% element-structure match vs the shipped CF |
| `.hdbprocedure` | **Done** — copied with SQL hygiene |
| `.xsodata` → `service.cds` + `service.js` | **Done** — 19 pairs; import paths match the shipped ones character-for-character |
| `.xsjs` / `.xsjslib` — **JDBC → `cds.run`** | **Done** — `transform/db.js` analyses, `transform/emitdb.js` emits. **655/673 Corpus A (97.3%)**, **1073/1123 Corpus B (95.5%)**; with `--ai claude`, 656 and 1088 (§28) |
| `.xsjs` / `.xsjslib` — **`$.import` → ES imports** | **Done** — `transform/imports.js`. 322 resolved; **0 point at the wrong file** vs the shipped CF |
| `.xsjs` / `.xsjslib` — **`$.request` / `$.response` / `$.session`** | **Done** — `transform/request.js`. 57 entry points found and exported; the idiom went from ~1,000 sites to 66, each named |
| **project shell** — `package.json`, `mta.yaml`, `srv/index.cds`, `xs-security.json`, `db/` deployer | **Done** — `emit/project.js`. Everything derived; `cds build --production` passes on both corpora (§23) |
| **cross-file `await`** | **Done** — `emit/awaits.js`. 1,275 awaits added over both trees; `checks/awaits.js` reports 0 missing (§29) |
| **Tier 2 — `--ai`** | **Done** — `src/ai/`. `claude`, or any local runner; 16 statements settled, every one marked in the file (§28) |
| `.xsjs` / `.xsjslib` — **destination calls** | **Done** — `transform/http.js`. **59 of 63** outbound calls become `executeHttpRequest`; the 4 refusals are one file |
| `.xsjs` / `.xsjslib` — **`var` → `const`/`let`** | **Done** — `transform/vars.js`. Corpus A: 327 of ~1,400 declarations keep `var`, each with a `VAR_KEPT` note naming the scope rule; Corpus B likewise |
| **action handlers answer their caller** | **Done** — `emit/returns.js`. `service.js` wires `srv.on(alias, async (req) => { return await fn(req); })`; **103 Corpus A handlers returned nothing** and now carry a `HANDLER_NO_RETURN` finding. With `--ai`, the `handler-return` task picks the variable and this code writes the `return` |
| `.xsjs` / `.xsjslib` — **the `afterTableName` payload idiom** | **Done** — `transform/aftertable.js`. NEO passed the request body through a temporary table and wrote its answer back into it; CAP has neither. **1,354 statements across the three corpora.** On ADC/ARBDR: 432 payload reads become `req.data.<COL>`, 423 write-backs become a `return`, `HANDLER_NO_RETURN` drops 359 → 4 and `SQL_IDENTIFIER_INTERPOLATED` 937 → 82, all deterministically. TECK: 0 `afterTableName` left, and `CreateUpdateTemplates` now matches the hand migration |
| **the emitted `.cds` compiles** | **Done** — `checks/cdscompile.js`, run from `verify.js`, SKIPping when `@sap/cds-compiler` is absent (it is deliberately not a dependency). Its first run found three defects: `hana.NCLOB` (no such type — NCLOB is `LargeString`), a column named `KEY` (the parser reads it as the `key` modifier; now `![KEY]`), and a navigation alias written `.Managerql6kfx366e` (no quoting makes a dot legal; now renamed through the registry). All three corpora now compile whole — 474 / 634 / 2,255 `.cds` files, db and srv together |
| **`create using` actions take their payload** | **Done** — `emit/servicecds.js`. Actions were declared `action X() returns String`, so `req.data.<COL>` in the handler read a parameter CAP was never told about. Parameters are now the `with(…)` columns minus the `key(…)` ones, plus the column the handler actually reads where the clause omits it (`ACTION_PAYLOAD_FROM_HANDLER`, 19 on ICBC). ADC/ARBDR: 1,631 actions, all parameterised; TECK 167, matching the hand migration's `(PAYLOAD: LargeString)` |
| **converting a NEO subfolder** | **Done** — `inferRootPackage` in `convert.js`. `convert <repo>/RSM` used to produce 1,809 `PROXY_NOT_FOUND` blockers because the `.xsodata` names views by full package path. The missing prefix is read back off the references and put in front of every emitted path, so the subtree run is byte-identical to the whole-tree slice bar service-name collision qualifying. `--root-package ""` opts out |
| **`--ai` looked broken on a subtree, wasn't** | **Diagnosed, plus `AI_TIER_SUMMARY`.** `convert ARBDR/RSM --ai …` finished in ~1s with no visible change — indistinguishable, from the terminal, from a broken backend. It wasn't: verified `cmd:ollama run qwen2.5-coder:7b` end-to-end (`dbscan --show` on `HRS_AdminConsole.xsjslib` took 51s and genuinely converted the one held-back statement). RSM's own refusals just don't contain a `hole-classify` or `handler-return` shape — Tier 1 already resolved almost everything else, and its one `SQL_DYNAMIC` is a `query += …` build, which is explicitly excluded from AI classification (§ "confident, silently wrong conversion"). `ensureHandlerReturns` now returns `asked` alongside `added`, and `convert()` emits one `AI_TIER_SUMMARY` note whenever `--ai` is given, saying how many times each task was actually put to the model — so "0" and "never asked" are visible instead of inferred. Side finding, not acted on: the local 7B model misclassified a `.join("','")`-built list hole as `value` rather than `list` on one statement — caught by nothing but the `AI-CLASSIFIED` comment it leaves for human review, which is exactly what that comment is for |
| **service name/`@path` no longer renamed on collision** | **Reverted, on request.** `assignServiceNames` used to prefix every member of a colliding group with a folder segment (`service Employee_RSMfbIx… @(path:'/Employee_RSMfbIx…')`), changing the URL a UI already calls. It now always returns NEO's own name and path, unqualified — a collision is still reported as `SERVICE_NAME_COLLISION`, naming every other file sharing it, but nothing is renamed; resolving it is a human decision (rename one `.xsodata`, or hand-edit one `service.cds`). On ADC/ARBDR/RSM: 45 `SERVICE_NAME_COLLISION` findings, 0 renames |
| **parameterised entities in `service.cds`** | **Done.** A `create using`-free entity whose calc view takes a HANA parameter (`<variable parameter="true">`) used to be projected as `entity A as projection on X;` — legal HANA, illegal CAP: `X` requires a parameter list and nothing supplied one. `servicecds.js`'s `paramSignature` now reads the parameter list off the calc view itself (`hit.cv.parameters`, plumbed through `resolveProxy` in `convert.js` — the same list `cdsproxy.js` already used to write the *proxy's* signature) and renders `entity A(P: T) as projection on X(P: :P)` on both a bare and a column-restricted projection. Not sourced from the `.xsodata`'s own `parameters via key and entity "…" results property "Execute"` clause — that names an OData Parameters entity, and on the corpus that name routinely does not match the parameter's real name (`svxuac4g3i7dhzl4` vs. the view's actual `pTABID`). Verified against `@sap/cds-compiler` directly (installed transiently, not a dependency): the emitted syntax compiles clean. ADC/ARBDR: 98 parameterised projections now correct, 0 before |
| `.hdbprocedure` — **name and schema** | **Done** — `emit/hdbprocedure.js`. 880 procedures across the three corpora were previously copied verbatim, so each declared `PROCEDURE "ARBDR"."ARBDR.RSM.…::prX"`, carried `DEFAULT SCHEMA ARBDR`, and named the schema on every table — none of which exists in an HDI container. Now: name flattened by `flattenEntityName` (the form the handler's unquoted `CALL` folds to), `DEFAULT SCHEMA` dropped, qualifiers stripped, `SESSION_USER` replaced. `checks/procnames.js` guards the two sides agreeing; on ADC/ARBDR 462 of 467 `CALL` targets resolve, and the 5 that do not are dangling in the NEO source |
| **hardcoded schema in the emitted JS** | **Done** — the SQL-variable drop in `emitdb.js` now asks whether *this assignment* can still be read rather than whether the *name* is used anywhere, which one shared `query` variable per function always answered yes to. ADC/ARBDR: string literals still carrying `"ARBDR".` fall 1,657 → 666, and 653 of those sit in files that also hold a statement the tool refused, which must keep its SQL verbatim |
| **Prettier over the emitted JS** | **Done** — `src/emit/format.js`, run from the CLI after every offset-based pass (Prettier's API is async, `convert` is not). 0 failures on all three corpora; `--no-format` keeps the spliced output diffable against NEO |
| **bundled CDS proxies** | **Done, opt-in** — `cdsProxy.bundle`: `null` (default, one `.cds` per view), `'all'` (`--single-cds`, one `db/cds/schema.cds`), `'module'` (`--module-cds`, one `db/cds/<MOD>/<MOD>_schema.cds`). Corpus A's 454 proxies become one 260 KB file; ADC/ARBDR's 2,132 become five module files. `service.cds` `using` lines follow either way |
| **`service.cds`/`.js` named after the `.xsodata`** | **Done, on request; opt-out via `--generic-service-names`.** Every `.xsodata` folder used to emit a file called `service.cds` — indistinguishable from every other folder's `service.cds` except by directory, and 24 identical-looking tabs in `srv/index.cds`'s `using` list. `layout.js`'s `targetsFor` now names the pair after the `.xsodata`'s own basename (`RSMfbIx3y5iamfxJhGOD9yEJ1ejviXQLb23.xsodata` -> `.cds`/`.js`); two `.xsodata` sharing a folder still merge into one pair, named after the first. `serviceNaming.generic` (`--generic-service-names`) reverts to the old name for a project that wants it. Verified byte-identical content either way (only the filename differs) and re-checked against the real CDS compiler on both TECK and ADC/ARBDR/RSM — same pre-existing `SERVICE_NAME_COLLISION` error count under both naming schemes, proving the file-naming change is orthogonal to the (already-known, already-accepted) `service` identifier collisions |

Running `convert` on Corpus A emits **1,662 files** from NEO alone — including **87
handlers** — with **no blockers**. Corpus B emits 2,181 files, 118 of them handlers,
also with no blockers. Both commands exit 0.

**And the result builds.** Put through a real CDS compiler, both emitted trees
pass `cds build --production` with 0 errors and 0 warnings, producing the
`gen/srv` and `gen/db` that `mta.yaml` deploys. Getting there took five fixes
for defects nothing else could see — see §23, which is the most important
section in this file for anyone extending the tool.

Two checks run over the emitted tree itself, needing no reference:

- **Every relative import resolves to a file we also emit** — 421 of 429. The 8
  that do not point at a foreign schema or at the one library withheld for not
  parsing, and each already has its own finding.
- **Every function an `.xsodata` wires up is actually exported by its handler** —
  18 are not, across both corpora (`HANDLER_EXPORT_MISSING`). Those are NEO
  defects: the named function does not exist in the library at all, so the entity
  was wired to nothing in NEO too. CAP would only say so at startup.

### What is NOT converted yet

The `$.` surface is a closed set. This is what is *left in the emitted
JavaScript*, measured by walking the output AST of all 199 rewritten files
across both corpora — not by grepping, which matches the idioms quoted in
comments:

| Idiom | Sites left | Why |
|---|---|---|
| `$.db.getConnection` | 39 | belongs to a statement the JDBC tier refused |
| `$.response.setBody` | 33 | `RESPONSE_BODY_MIDBLOCK` — code runs after it, so `return` would change the flow |
| `$.response.status` | 27 | `RESPONSE_STATUS_MIDBLOCK` / `_DYNAMIC` |
| `$.jobs.Job` | 12 | out of scope (D6) |
| `$.request.parameters[i].value` | 10 | indexed rather than named — reported individually |
| `$.web.WebRequest` + `readDestination` + `Client` | 6 | `HTTP_REQUEST_CONDITIONAL`, all in one file |
| `$.response.headers.set` | 3 | no handler equivalent |
| `$.session.samlAttribute[…]` | 2 | indexed rather than named |

**132 sites, and `node checks/leaks.js <neo-dir>` prints exactly that table** —
it walks the AST of every `.js` the tool emits, so a `$.` quoted in a comment or
in one of our own headers cannot inflate it.

Every one of those carries a named finding. `$.session`, `$.request.method`,
`$.request.body`, `$.request.parameters.get`, `$.util.codec.*`, and all the
`$.net.http` status and method constants are **gone**. So is the whole
destination-call surface bar the six sites above — it was 155.

The invariant that check enforces is not the count: *a converted file whose
findings are empty must contain no `$.` idiom at all* — a leak nobody was told
about is the one failure mode a reader cannot see. It passes on both corpora,
and it has now caught five real bugs across the JDBC, request and HTTP tiers
that reading the code did not.

Also still open:

- `cds watch` against a real HANA has still never been run — see "Next session".
- `xs-security.json` is emitted with no scopes. NEO does not have them (§23).
- `cds watch` against a real HANA has never been run. §23 found five defects the
  moment a real compiler saw the output; the runtime has not looked yet.

**`score` reads 100.0% for handlers.** 58 of our 88 land on the shipped CF's
exact path, none in the wrong folder, and the other 30 are NEO files the hand
migration did not carry across — counted in a `DROP` column, not against us
(§21). Of the 6 handlers the shipped CF has and we do not, 5 do not exist in NEO
at all (D8) and the 6th is the library withheld for declaring a function twice.

### The JavaScript numbers (`dbscan`, both corpora)

| | Corpus A | Corpus B |
|---|---|---|
| `.xsjs`/`.xsjslib` files | 88 | 121 |
| parse failures (acorn) | **0** | **0** |
| JDBC statements found | 673 | 1123 |
| **converted automatically** | **655 (97.3%)** | **1073 (95.5%)** |
| … with `--ai claude` (§28) | **656 (97.5%)** | **1088 (96.9%)** |
| `$.import` resolved | 119 | 203 |
| request entry points found | 21 | 36 |
| outbound HTTP calls converted | 20 / 20 | 39 / 43 |
| files rewritten | 85 | 114 |
| rewritten files that load | 84 | 111 |
| `CALL` OUT parameters resolved from the procedure signature | 19 | 99 |
| identifier interpolated into SQL (a note, not a refusal) | 251 | 430 |
| value or list interpolated into SQL — DDL, or a joined list (a note, §26) | 19 | 18 |
| column read in a `catch`, so it reads the first row (a note, §26) | 0 | 47 |
| SQL still assembled at run time | 6 | 25 |
| cross-file `await`s added by `emit/awaits.js` (§29) | 543 | 732 |
| conditional binds still refused (all on chains blocked by something else) | 1 | 99 |

The four files that do not load are NEO defects the conversion exposes rather
than causes — each declares a function twice, which a sloppy-mode XSJS script
allows and an ES module rejects. Each gets a `DUPLICATE_FUNCTION` finding and a
comment naming both lines. See §15.

**Four earlier figures in this file are superseded and must not be compared with
these.** The 69.6% in §15 counted only the 45% of statements the analyser could
then see. The 50.8%/45.4% pair counted every identifier interpolation as a
refusal; §20 explains why that was wrong. The 86.6%/79.7% pair counted a
CALL's OUT parameters as missing binds; §22 explains why that was wrong too.
The 90.8%/89.4% pair refused every value spliced into SQL and every column read
in a `catch`; §26 explains why both were wrong.

### Where the code is

```
bin/neo2cf.js          CLI — arg parsing and rendering only
src/convert.js         the pipeline: parse everything, then emit everything (332)
src/core/              intake, config, layout, naming, artifacts, write guards
src/parse/             calcview, sqlscript, xsodata, procsig (.hdbprocedure IN/OUT signatures)
src/emit/              hdbcalcview, hdbfunction, cdsproxy, servicecds, servicejs,
                       project (package.json / mta.yaml / srv-index.cds / xs-security),
                       awaits (cross-file await propagation over the emitted tree, §29)
src/ai/                Tier 2 (§28) — backend.js (the only non-determinism in the
                       tool), tasks.js (the registry + validators), index.js (the driver)
score/compare.js       runs convert(), scores the files it wrote (§24)
checks/verify.js       THE SWEEP — tests, convert, checks, score, cds build
checks/ceiling.js      what each refusal is worth — run before building for one
checks/leaks.js        what is left of the $. surface, and whether it is named
checks/emitted.js      scope, sentinel and re-parse checks over an emitted tree
checks/awaits.js       every cross-file call to an async function is awaited
src/transform/         the JavaScript tier
  file.js      174   composes the passes over ONE parse; owns applyEdits and the re-parse check
  js.js        101   parse / walk / parentMap / applyEdits  (the substrate)
  db.js       1263   JDBC chain ANALYSIS — facts + gaps, emits nothing
  emitdb.js    536   renders a resolved chain into await cds.run(…)
  imports.js   207   $.import + refs -> ES imports; .xsjslib export block
  request.js   540   $.request/$.response/$.session, the entry fn, the export
  http.js      411   $.net.http/$.web.WebRequest -> executeHttpRequest
  scan.js      129   walks a tree, converts, reports (dbscan only)
src/report/render.js   terminal output
score/compare.js       structural scorecard
```

Three rules that are load-bearing and easy to break by accident:

- **The AST locates; the original text is edited by offset.** Never regenerate
  JavaScript from the parse tree — it would reformat all 88 files and drop every
  comment, leaving nothing to diff against NEO.
- **All passes contribute edits to one `applyEdits`.** That is what makes two
  transforms claiming the same bytes an error instead of a silent winner.
- **Rewrite *around* a sub-expression, never over it.** A pass that replaces a
  whole statement locks every other pass out of its interior. `request.js`
  therefore emits pairs of edits bracketing the argument it keeps, and the
  passes run imports → request → **db last**, because the db pass is the one
  that *moves* text: a bind value leaves its `setNString(…)` and lands inside
  `cds.run`'s array, so it has to carry whatever the earlier passes rewrote
  inside it (`ctx.inlineRewrites`). Getting this wrong is silent — the moved
  copy simply keeps the old `$.` idiom.

### The single most important thing to know

**The shipped Corpus A CF is a valid oracle for *structure*, not for *text*.** It
contains large-scale post-migration edits — a family of five `*BCK` columns in
212 files, SQL keywords uppercased, whitespace reformatted, `'Active'`→`'active'`
— that no tool reading NEO could produce. Every content difference we chased
traced back to one of these. Score structurally; measure content fidelity as
*faithfulness to NEO*, which needs no reference tree. Detail in §12.

### How to verify a change — the whole sweep

One command. Everything must pass; it exits non-zero if anything does not.

```bash
cd C:/Sodales/Tools/neo-to-cf-migrator
npm run verify --   C:/Sodales/Projects/TECK/TECK-neo-code   C:/Sodales/Projects/ICBC/Migration/ICBC-neo-code   --expect C:/Sodales/Projects/TECK/neo-to-cf-teck-jbd-backend   --cds C:/Sodales/Projects/TECK/neo-to-cf-teck-jbd-backend/node_modules/.bin/cds
```

```
  PASS  tests                                          264, 0 failures
  PASS  convert TECK-neo-code                          1662 files, no blockers
  PASS  convert ICBC-neo-code                          2181 files, no blockers
  PASS  emitted tree — scope, sentinels, re-parse      270 .js, 0 problems
  PASS  refusal ceilings                               1728 / 1796 resolved
  PASS  $. leaks — every remaining site has a finding  132 sites, all named
  PASS  cross-file awaits — every async call awaited   1594 calls, 0 missing
  PASS  score                                          99.9%
  PASS  cds build --production  TECK-neo-code          0 errors, 0 warnings
  PASS  cds build --production  ICBC-neo-code          0 errors, 0 warnings
```

**`cds build` needs `@sap/cds-dk`, which this repo does not install.** `--cds`
points at any copy of it; the shipped CF has one, which is how §23 and every run
since have used a real compiler without installing anything. Reading that tree
is fine; **never write to it** (design rule 1). `--no-build` skips that step.

The pieces still run on their own — `node checks/ceiling.js`, `checks/leaks.js`,
`checks/emitted.js`, `bin/neo2cf.js dbscan` — and `--code <CODE>` on `ceiling.js`
is how every one of the last four buckets got classified before a line was
written for it.

### Next session, in order

**Both tiers are built and the sweep is one command.** Every artifact type
converts, 96.2% of JDBC statements convert with no model at all, every `$.`
idiom is either converted or named, every cross-file `await` is in place, and
the output passes CAP's own compiler. What is left is one thing the tool cannot
do to itself, and two the user decides.

1. **`cds watch` against a real HANA.** This is now the only untested layer and
   it is where the next class of defect is. §23 found five defects the moment a
   real *compiler* saw the output; §29 found 1,266 the moment something read the
   whole tree at once. Nothing has yet asked the *runtime* a single question.
   What to expect there, in likely order:

   - SQL the compiler never looked at — `cds.run` takes a string, so every one
     of the 1,728 converted statements is unverified until HANA parses it.
   - `cds.context` outside a request. `transform/request.js` maps `$.session`
     and `$.request` onto CAP's ambient context; a job or a startup path has no
     request, and `cds.context.user` is then undefined.
   - The `db/cds` proxies against real deployed calculation views: names,
     types, and whether the projections' keys survive a real deployment.

   The tool cannot do this for you — it needs credentials and a container. What
   it can do is make the output easy to run: `convert`, `npm install`,
   `cds watch --profile hybrid`.

2. **Whether Tier 2 is worth pointing at a *local* model** (D3's real target).
   The plumbing is backend-agnostic and already takes one:

   ```bash
   node bin/neo2cf.js convert <neo> -o out --write --ai "cmd:ollama run qwen2.5-coder:7b"
   ```

   `claude -p` answered 16 of 16 and the deterministic gate rejected none of
   them, which proves the plumbing but says nothing about a 7B model — the
   validator has never actually had to bite on a real answer. Running the same
   16 through a local model and reading the accept/decline split is a
   half-hour's work and is the only way to answer "how good does the model need
   to be". §9 of CONVERSION-STRATEGY.md has the shortlist.

3. **The deferred cleanup** — customer names out of the docs. The tool is now
   complete and tested, so the condition is met; it is still the user's call,
   and it is a one-way rewrite of four documents.

**What is deliberately NOT left as work:** the 68 statements Tier 1 refuses.
Every one has been classified (§26, §28) and they are refusals on purpose —
dead code, a procedure in a schema we do not have, SQL that arrives in a request
body, a list built up in a loop. The honest output for those is the finding.

---

## 1. The deliverable, in the user's words

> "My direct deliverable is a tool to which I will give a SAP NEO Codebase and it
> will give me SAP CF codebase following same folder structure as what neo was
> following, at least converting at what possible at its best efforts. Anyhow we
> need to manually test each and every api out there but I want to reduce the
> developer's efforts as much as possible."

Three constraints that follow from that:

1. **Output mirrors NEO's own tree**, transformed by a known folder mapping. Not
   a greenfield CAP app.
2. **Partial output is success.** A file with `NEEDS HUMAN REVIEW` is acceptable.
   Silently inventing logic is not.
3. **Every API gets hand-tested afterwards regardless.** So the objective is
   *developer hours saved*, not correctness percentage. A tool that converts 70%
   and flags the rest honestly beats one that converts 95% and hides where it
   guessed.

Later addition:

> "tool's main goal should be conversion at the most possible success rate in
> both modes, ai and without ai. Mostly will use with ai but will try to do
> without AI also as what we can do best."

---

## 2. Decisions — all confirmed by the user

| # | Decision | Detail |
|---|---|---|
| D1 | **Independent conversion, NOT cleanup** | The tool converts NEO directly. It does not consume SAP migration assistant output. |
| D2 | **Two modes, both first-class** | `--ai none` (deterministic) and `--ai <backend>`. Highest achievable rate in *both*. |
| D3 | **AI backend is pluggable** | Target is the **on-premise local model**. For now: **Claude Code driven headlessly**, mimicking API usage. |
| D4 | **Build FRESH in `neo-to-cf-migrator`** | Copy-paste whatever is useful from `migration-cleanup-toolkit`, but this is a new tool — that one's goal was different. |
| D5 | **CLI first, UI later** | Keep the architecture UI-compatible from day one (core returns data/events; only one module writes to a terminal). |
| D6 | **Out of scope entirely** | `.xsjob` · `.xshttpdest` · `.analyticprivilege` · `.xsaccess` · `.xsprivileges` — "no use of those in CF app" |
| D7 | **`.hdbtable` out of scope** | Tables matter in CF but are generated manually by separate scripts from the live DB. |
| D8 | **Tool migrates what is in NEO. Nothing else.** | ValidationUtil, Middleware, rate limiting etc. were **added later by the developer**. Not the tool's concern. Do **not** scaffold them. |
| D9 | **Corpus B was assistant + Claude Code cleanup** | So `ICBC-cf-code` shows what SAP's assistant emits, **not** what this tool should emit. **Corpus A is the output reference.** Corpus B is a NEO-input data point only. |

D8 corrects an earlier wrong recommendation of mine (I had proposed scaffolding
the CF-only utilities). D9 explains Corpus B's 584 `.hdbview` — assistant artifacts.

---

## 3. Reference material on disk

| What | Path | Role |
|---|---|---|
| From-scratch KB | `C:\Sodales\Projects\migration-kb` | Rules, checklist, templates. **Read `rules/checklist-final.md` first.** |
| Cleanup KB | `C:\Sodales\Projects\cleanup-tool\cleanup-kb` | 25-item checklist (item 25 = `SESSION_USER` fix, not in the other list) |
| Existing engine | `C:\Sodales\Tools\migration-cleanup-toolkit` | **8,189 lines src, 323 tests, zero deps.** Copy-paste source (D4). |
| NEO source (Corpus A) | `C:\Sodales\Projects\TECK\TECK-neo-code` | 848 files. Primary test input. |
| CF result (Corpus A) | `C:\Sodales\Projects\TECK\neo-to-cf-teck-jbd-backend` | **The output oracle.** |
| NEO source (Corpus B) | `C:\Sodales\Projects\ICBC\Migration\ICBC-neo-code` | 1,117 files. Second input. |
| CF result (Corpus B) | `C:\Sodales\Projects\ICBC\Migration\ICBC-cf-code` | 3 projects (JBD/DSM/TLW). Assistant output — not an oracle. |

**Never modify any of the four codebases.** Both KBs say so. Graphify wrote a
cache dir into two of them during this session; removed and verified (§8).

---

## 4. Measured facts (from disk, not documentation)

### Every extension in the NEO corpora

| Extension | Corpus A | Corpus B | Verdict |
|---|---:|---:|---|
| `.calculationview` | 454 | 587 | Deterministic |
| `.hdbprocedure` | 169 | 203 | Deterministic |
| `.xsjs` | 60 | 50 | **JS — three tiers** |
| `.xsjslib` | 28 | 71 | **JS — three tiers** |
| `.xsodata` | 21 | 48 | Deterministic (measured, fully derivable) |
| `.xsaccess` | 21 | 42 | Out (D6) |
| `.xsprivileges` | 20 | 42 | Out (D6) |
| `.analyticprivilege` | 20 | 29 | Out (D6) |
| `.xsjob` | 34 | 22 | Out (D6) |
| `.xshttpdest` | 9 | 15 | Out (D6) |
| `.hdbtable` | 6 | 0 | Out (D7) |
| `.hdbtablefunction` | 0 | 1 | Deterministic |
| `.xsapp` | 1 | 1 | Out |

**Only three types carry JavaScript.** 88 files in Corpus A, 121 in Corpus B ≈ 12% of
in-scope files. That is the hard part; everything else is XML/SQLScript/config.

### CF side (Corpus A — the oracle)

454 `.calculationview` → **454** `.hdbcalculationview` + **454**
`TABLE_FUNCTION_*.hdbfunction` + **454** `db/cds` proxies. Exactly 1:1:1:1.
169 procedures → 157. 21 `.xsodata` → 19 `service.cds` / 19 `service.js`.

### From migration-cleanup-toolkit's own corpus scan (trust these, they are measured)

| | |
|---|---:|
| NEO calc views | 587 |
| **Pure-script — safe to generate from** | **587 — 100%** |
| Parameterized | 222 (38%) |
| Duplicate scenario ids | 92 groups |
| Proxy column set + types reproduced by generation | **92.8%** |

100% pure-script is what makes *generate-from-NEO* safe rather than
*repair-the-assistant's-SQL*. Do not re-derive this; it is done.

---

## 5. The conversion strategy (full detail in `docs/CONVERSION-STRATEGY.md`)

### The XSJS API surface is a closed set — ~15 idioms

Counted across both corpora: `$.import` (358) · `$.response.setBody` (321) ·
`$.response.status` (278) · `$.db.getConnection` (214) · `$.response.contentType`
(149) · `$.request.method` (98) · `$.net.http.*` constants (~350) ·
`$.web.WebRequest` (76) · `$.net.http.readDestination` (61) · `$.net.http.Client`
(61) · `$.util.codec.decodeBase64` (59) · `$.session.getUsername` (57) ·
`$.request.body.asString` (34) · `$.request.parameters` (22) · `$.jobs.Job` (13,
out of scope).

**That is the whole surface.** XSJS is not an open-ended language problem.
This is the single most important finding — it is why AI is not the only option.

### Three tiers

- **Tier 1 — deterministic AST transform** (`acorn`; XSJS is ES5 + the `$`
  global). Imports, the JDBC-chain collapse recognised by *data flow*, SQL
  dialect fixes, request/response idioms, **async propagation computed over the
  call graph**. What it can't decide becomes a **hole** carrying the NEO excerpt
  and the reason.
- **Tier 2 — AI fills holes only.** Never a whole file "just in case".
- **Tier 3 — human**, for anything failing validation twice.

Both modes run Tier 1 identically. No-AI leaves holes as `NEEDS HUMAN REVIEW`.

### Execution is per FUNCTION, not per file

```
prompt = SYSTEM(migration rules, fixed/cacheable)
       + FACTS  (resolved imports · real table names post-schema-strip ·
                 procedure signatures incl. OUT-params-vs-result-set ·
                 the function's call sites)
       + NEO    (the original function, verbatim)
       + PARTIAL(what Tier 1 already produced around it)
       + ASK    ("return only the body of function X")
```

Then a **deterministic gate**: parses · no surviving `$.` · same name/arity ·
every import resolves to a real emitted file · no invented table names · SQL
passes the same checks as Tier 1. Fail → retry once with the failure attached →
then human. **The model never writes a file.**

Why not file-level: files reach 49 KB (`EmailNotifications.xsjslib` = 48,924 B),
one shot gives no verification granularity, blows a local model's context, and
discards what Tier 1 already proved.

### Evidence that file→AI→file is the wrong shape

From the user's own shipped CF code (headers say `//converted from: …/async_xsjs/…`,
so it already came from that process):

- **`Common_util.js`** — simplest file in the corpus, zero `$.` calls. Conversion
  silently changed behaviour: `isvalidateDate` returns `''` in NEO, `null` in CF,
  with the NEO version commented out above a hand-written replacement. `async`
  added to `checkLeapYear` for no reason.
- **`TECK_HR_Notes.js`** — two checklist item-16 bugs: `const User = await
  cds.run('SELECT … FROM DUMMY')` returns an **array** then is bound as a scalar;
  and `result.USERCOUNT` on a `SELECT` should be `result[0].USERCOUNT`.

Item 16 is on the checklist *because this keeps happening*.

---

## 6. What to take from `migration-cleanup-toolkit`

Building fresh (D4), but this is proven, tested source. High-value copy targets:

| From | Why |
|---|---|
| `src/parsers/` — calcview, xsodata, xsjslib, sqlscript, xml, servicecds, cdsproxy, handlerjs | The parsers are the expensive part |
| `src/generator/` — cdsproxy, hdbfunction, hdbprocedure, servicecds, **handlerimports, resolve** | `handlerimports`+`resolve` = deterministic import resolution, directly reusable in Tier 1 |
| `src/core/fsguard.js` | Read-only enforcement in code, not convention |
| `src/core/finding.js`, `patch.js`, `events.js` | Finding/Patch model + event bus = the UI boundary (D5) |
| `src/ai/provider.js` | Two adapters (`openai-compatible`, `anthropic`) + injectable `fetchImpl` |
| `src/ai/triage.js` | The disposition table — AI / DETERMINISTIC / HUMAN / NONE |
| `research/scan-drop-shapes.js` | "Classify folders by the extensions inside them, never by name" |

Its golden constraints are worth adopting verbatim:

> 1. Never write to the NEO tree. 2. Dry-run is the default. 3. Every change is
> a reviewable patch. 4. NEO is the source of truth. 5. **A rule that cannot
> decide deterministically emits a finding, not a guess.**

And its triage principle:

> "The tempting failure mode is to hand the model every unresolved finding and
> let it sort them out. That is worse than useless — it spends tokens on work a
> parser already does deterministically, and it **launders a mechanical transform
> into a probabilistic one**."

**What NOT to take:** its section discovery is rooted in the assistant drop
(`discoverSections(dropPath, cfg)`). We root at NEO. Its `01-goals.md` says "this
is not a from-scratch migration tool" — that is the part we are changing.

---

## 7. The transformation rules (from migration-kb, verified)

### Folder mapping

```
NEO                                                  CF
<APP>/<MOD>/<SUB>/Views/*.calculationview   →  db/src/<MOD>/<SUB>/Views/*.hdbcalculationview
                                            →  db/src/<MOD>/<SUB>/Views/TABLE_FUNCTION_*.hdbfunction
                                            →  db/cds/<MOD>/<SUB>/Views/<FLAT_UPPER>.cds
<APP>/<MOD>/<SUB>/Procedures/*.hdbprocedure →  db/src/<MOD>/<SUB>/Procedures/*.hdbprocedure  (no cds proxy)
<APP>/<MOD>/<SUB>/Library/*.xsjslib         →  srv/lib/<SCHEMA>/<APP>/<MOD>/<SUB>/Library/handlers/*.js
<APP>/<MOD>/<SUB>/Services/*.xsjs           →  srv/lib/<SCHEMA>/<APP>/<MOD>/<SUB>/Services/handlers/*.js
<APP>/<MOD>/<SUB>/Services/*.xsodata        →  srv/lib/<SCHEMA>/<APP>/<MOD>/<SUB>/Services/service.cds + service.js
```

Two asymmetries: **`db/cds/` drops the `<APP>` wrapper**; `srv/lib/<SCHEMA>/<APP>/…`
keeps it. And the CF bucket name = the real NEO top-level folder name.

### Naming — flatten

`TECK.JOB_BIDDING.JB_ADMIN_CONSOLE.Views::TECK_M_getSUPList`
→ `TECK_JOB_BIDDING_JB_ADMIN_CONSOLE_VIEWS_TECK_M_GETSUPLIST`
(every `.` and `::` → `_`, then UPPERCASE. File name = entity name.)

⚠ Not fully deterministic in the reference — the *same* view came out short
(`VIEWS_TECK_JB_CLOB`) in one module and full in another. Since our tool
generates both the proxy and the `using` statements that reference it, it can be
self-consistent.

### Numeric-leading identifiers

CDS/HDI reject identifiers starting with a digit. Reference renamed by hand and
**inconsistently** (`91Efu5zcsYvGmdP`→`yuEfu5zcsYvGmdP`; `9UPBK9QDitgIuOp`→`I…` in
one module and `o…` in another). Use a deterministic scheme; publish the
before/after table to the UI team either way. **Needs team sign-off** — these are
OData names the UI calls.

### The 7c-vs-14 boundary (most likely rule to get wrong)

```
service.js   srv.on(alias, req => handlerFn(req))     ← 14: pass req DIRECTLY
   ↓
Library/handlers/*.js  function handlerFn(req) {
     const payload = req.data.PAYLOAD;                 ← 14: extract from the REQUEST
     await getEmailTemplates(1, fields);               ← 7c: helpers get PRIMITIVES
```

Test is **distance from the request**, not the folder.

### Deterministic checklist fixes

item 3 (`dataCategory`/`applyPrivilegeType`) · 25 (`SESSION_USER`) · 8/12/23
(schema strip) · 13 (proc call paths `.`→`_`, `::`→`_`, drop quotes) · 21
(`UTCTOLOCAL`) · 22 (quote sequence names) · 24 (`LOWER()=LOWER()`) · 7a
(`require`→`import`) · 7b (drop `'CREATE'`) · 9 (no stray `.properties`).

⚠ Item 24 needs care — must fire only on identifier-vs-identifier equality, not
numeric/date comparisons. Needs its own tests.

---

## 8. Environment notes

- **graphify** installed (`graphify 0.9.54`, skill at `~/.claude/skills/graphify/`).
  It created a **global `~/.claude/CLAUDE.md`** that did not exist before.
- Interpreter with graphify: `C:\Users\SLS1402\AppData\Roaming\uv\tools\graphifyy\Scripts\python.exe`
  (`%APPDATA%`, **not** `%LOCALAPPDATA%`).
- `uv` installed via winget; on PATH only in **new** shells.
- ⚠ **graphify's `extract(cache_root=…)` writes into the scanned tree.** It wrote
  `graphify-out/cache/` into `TECK-neo-code/` and `neo-to-cf-teck-jbd-backend/srv/`.
  Removed and verified. Point `cache_root` at a scratch dir.
- **graphify cannot see NEO files** — detect found 5 of 848 (only `.txt`/`.md`).
  It does not know `.xsjs`, `.calculationview`, `.hdbprocedure`, `.xsodata`. An
  extension shim would fix it cheaply. On the CF side it worked well: 489 nodes,
  1542 edges from `srv/`. Graph kept at `graphs/teck-cf/graphify-out/`.
- **Claude Code CLI confirmed** for D3: `claude 2.1.261` at
  `C:\Users\SLS1402\.local\bin\claude.exe`, with `-p`, `--output-format`,
  `--append-system-prompt`, `--allowed-tools`, `--model`, `--permission-mode`.
  (`--max-turns` does **not** exist.) Use `--allowed-tools ""` so the model
  transforms text and cannot touch the reference codebases.

### Sibling tool built earlier this session

`C:\Sodales\Tools\hana-data-mover` — NEO→CF and CF→CF **data** movement, React +
Express, one port, working. Its patterns are directly reusable here: a validation
pass that runs before anything is written, findings that each carry their fix,
verdicts of ready/warning/blocked, and `errors.js` mapping failure → actionable
fix. It also owns `.hdbtable` concerns (D7).

---

## 9. Where we stopped — pick up here

### RESOLVED 2026-09-06 — both blockers closed by measurement

**Q1 `.xsjs` handling — ANSWERED BY EVIDENCE.** 35 of Corpus A's 60 `.xsjs` survived
into CF, and every one landed at `srv/lib/<SCHEMA>/<APP>/<MOD>/<SUB>/Services/handlers/X.js`
— its own handler file, mirroring the NEO path. It does NOT fold into the service
layer. The 25 that did not survive were `JB_DATAMIGRATION` (whole module dropped),
root-level table tooling, and `test`/`test2`/`test1234` scratch files. No user
decision needed.

**Q2 Tier-1 coverage — MEASURED.** The JS problem is the DB problem: 73 of 88
files touch the DB, across **505 `prepareStatement` sites** (225 of them
`prepareCall`). Column access is **897 positional `getX(N)`, zero by name**, and
**only 4 `SELECT *` against 446 explicit-column SELECTs** — so ordinal-to-column
resolution is viable for ~99% of queries. Roughly **400 of 505 sites are
statically resolvable**; the ~109 concatenated-SQL sites are the genuine AI work.
This inverts the starting assumption: the DB layer is MORE machine-tractable than
model-tractable, because it turns on facts the tool holds and the model would
have to invent. Detail in `docs/CONVERSION-STRATEGY.md` §8.

### Superseded — the original two blockers

1. **`.xsjs` vs `.xsjslib` — 110 files, no precedent.** A `.xsjslib` is a library
   (functions in, functions out). A `.xsjs` is a *service entry point*, and in
   CAP that role is largely replaced by `service.cds` + `service.js`. So does a
   `.xsjs` become its own handler under `Services/handlers/`, or fold into the
   service layer? The toolkit's own notes say `.xsjs` handling was "never
   evidenced in any sample". **Needs a decision.**

2. **The number nobody knows:** how many of the 88 Corpus A JS files Tier 1 converts
   with **zero holes**. Could be 10, could be 60. It decides how much the AI tier
   actually matters, and it should be measured early rather than assumed.

### Then

3. **Rewrite `docs/PLAN.md`** — it is stale (written when the recommendation was
   "extend the toolkit"; D4 reversed that). Rebuild it around: build fresh in
   `neo-to-cf-migrator`, copy-paste from the toolkit, CLI-first with a UI-ready
   core, three-tier JS conversion, scorecard-driven.

4. **Build the scorecard first.** Run against `TECK-neo-code`, diff against
   `neo-to-cf-teck-jbd-backend`, print one percentage per artifact type. It is the
   only honest way to answer "most possible success rate in both modes" and to
   compare `--ai none` vs `--ai claude` vs `--ai onprem`.

   Two traps it must handle:
   - **Exclude files with no NEO ancestor** from the denominator (ValidationUtil,
     Middleware, rateLimitChecker, sweepGuard, hanaIdentifier, roleCheckAccess,
     custom-service, datapull-service, and the role-assignment set). Per D8 the
     tool should not emit them; counting them as misses would be lying.
   - **Exclude `NEO_DRIFTED` views.** The toolkit records that NEO was refreshed
     2026-08-11 and 8 of 27 already-migrated views no longer match — *every one a
     genuine NEO change, not a regression*. **The hand-migrated CF is not ground
     truth any more; it is a 2026-08 snapshot of it.**
   - Related: the reference has real item-16 bugs (§5). If the tool emits the
     *correct* `result[0].USERCOUNT`, the scorer will call it a mismatch. Needs a
     known-defects list.

### Other open questions

5. **On-prem model details** — endpoint, model name, context window. Decides
   whether FACTS + NEO function + PARTIAL fits. (Function-level was chosen partly
   to keep this small.)
6. **Numeric-leading rename scheme** — needs team sign-off (§7).
7. **Association naming convention** — the toolkit reports the corpus splits *3
   sections to 3*, and the wrong choice "fails at runtime with no build error".
   Human decision, not a default.
8. **Parameterized output unverified against a live deploy** — 222 of 587 views.
   The toolkit flags it as the highest-risk generated artifact. Deploy-test first.
9. **Procedures 169 → 157** in Corpus A, undocumented. Carry all, flag the delta.
10. **Async propagation across the import graph** needs a whole-project pass, not
    per-file. The hand migration demonstrably got this wrong.

---

## 10. (superseded) — this said "nothing is built yet"

True when written on 2026-09-05. Superseded by the build log in §§11-13 and the
status block in §0. Kept only so the chronology reads straight.

---

## 11. Build log

### Model decisions (2026-09-06, confirmed)

| Mode | Model | Why |
|---|---|---|
| Now, for iteration | **Claude Code headless** (`claude -p`) | Fast, known-good answers — proves the plumbing |
| Local baseline | **`qwen2.5-coder:7b`** Q4_K_M (~4.7 GB) via Ollama | Fits the team's 8 GB free budget; compare against Claude on the scorecard |
| Future | On-prem **Qwen3-Coder**, 32 GB dedicated GPU | Same `openai-compatible` adapter, different `baseUrl` |

Team hardware baseline, measured: **Dell Latitude 5480, i5-6440HQ (4c/4t, 2015),
24 GB DDR4-2400 mixed DIMMs, Intel HD 530 — no usable GPU.** So local inference
is CPU-only and bandwidth-bound: expect **~2–4 tok/s** on a 7B Q4. A 14B does not
fit in 8 GB; a 30B MoE does not fit at all (all experts must be resident).

**Architectural consequence, and the confirmed design principle:** *"keep the
tool's tasks small enough that the smallest model can do each chunk; a set of
small tasks becomes the big one."* This is the architecture, not an optimisation.
At 3 tok/s, a whole-file conversion is 1–3 minutes; a `column-resolve` returning
one identifier is 2 seconds. Tier 1 doing ~80% deterministically is what makes
local AI viable on this hardware at all.

Ollama notes: `OLLAMA_NUM_PARALLEL=1` (4 threads thrash under concurrency),
`num_ctx` 2048–4096 (prompts are one function + FACTS). Ollama speaks the OpenAI
API, so it needs **no new adapter**.

### Phase 1 — in progress

Built and passing (**41 tests**, no framework, no dependencies):

| Module | What |
|---|---|
| `src/core/artifacts.js` | Extension → kind. Every XS Classic type listed; excluded ones carry a reason so they are *recognised*, not ignored. Folders classified by contents, never by name. |
| `src/core/naming.js` | Flattening rule; deterministic numeric-leading rename; `RenameRegistry` that guarantees one NEO alias → one CF name and detects collisions |
| `src/core/layout.js` | NEO path → CF path, incl. the db/-drops-APP vs srv/-keeps-APP asymmetry |
| `src/core/intake.js` | `discover(NEO_ROOT)` — units, sections, schema inference from `$.import`, app inference, warnings |
| `src/report/render.js` | Terminal rendering (one of only two modules allowed to print) |
| `bin/neo2cf.js` | `neo2cf inventory <dir>` |

**Verified against both corpora**, counts matching every independent measurement:

| | Corpus A | Corpus B |
|---|---:|---:|
| calc views | 454 | 587 |
| procedures | 169 | 204 |
| JS (`.xsjs`+`.xsjslib`) | 88 | 121 |
| `.xsodata` | 21 | 48 |
| **convertible** | **732** | **960** |
| excluded (recognised) | 111 | 151 |

**Design flaw Corpus B caught, now fixed.** App inference returned 8 candidates for
Corpus B (`AUDIT_APPLICATION, Admin, CPM, DSM, GRV, JBD, Reports, TLW`) — those are
modules, not apps; Corpus B has no `<APP>` layer, and JBD/DSM/TLW become *separate CF
projects*. Since `<APP>` is dropped from `db/` paths, guessing would have merged
`DSM/Views` with `TLW/Views`. Now: one candidate is inferred, several is reported
as `APP_AMBIGUOUS` with the fix. Golden rule 5, working as intended.

Also surfaced: Corpus B imports from **COEDM (9) and HSBG (1)** — cross-container
references, matching migration-kb's open question about `BEAM`/`COEDM`.

### Next

- Scorecard shell (`neo2cf score`) — finishes Phase 1
- Phase 2: calc-view pipeline (454 files, the 1:1:1:1 win)

### Phase 1 COMPLETE — the scorecard, and what it proved

`neo2cf score <neo-dir> --expect <cf-dir>` compares predicted output paths
against a hand-migrated CF tree. Run before any emitter exists, it scores the
**layout rules on their own** — much cheaper than discovering a wrong path rule
after 454 files have been written to it.

**Corpus A vs the real hand-migrated CF: 1,615 of 1,661 predicted paths hit — 97.2%.**

| Role | Predicted | Exact | Hit |
|---|---:|---:|---:|
| `.hdbcalculationview` | 454 | 454 | **100.0%** |
| `service.cds` / `service.js` | 21 / 21 | 21 / 21 | **100.0%** |
| `TABLE_FUNCTION_*.hdbfunction` | 454 | 453 | 99.8% |
| `db/cds` proxy | 454 | 452 | 99.6% |
| `.hdbprocedure` | 169 | 156 | 92.3% |
| srv handler `.js` | 88 | 58 | 65.9% |

**All 46 misses are explained by something already documented:**

| Misses | Cause |
|---:|---|
| 20 | handler folder gone: 4 root table-tooling `.xsjs`, 13 `JB_DATAMIGRATION` (module dropped), 3 `xsjob_Notification` |
| 10 | handler name: 7 are `test.js`/`test2.js`/`test1234.js`/`Test.js` scratch files; 3 superseded (`AESENCODEDEODE`, `GenericCode`, a case-duplicate) |
| 13 | the documented 169 → 157 procedure shrink |
| 3 | the naming inconsistency in migration-kb OPEN_QUESTIONS #1 — **now confirmed on two files**: `COMMON_View/…TECK_JB_CLOB` and `JB_EMPLOYEE/…TECK_GETSESSIONUSER` came out short in the reference |

Excluding files that were deliberately never migrated, path accuracy on
files that *should* exist is **~99.8%**. The layout rules are right.

85 CF files were not predicted: 58 `.hdbtable` + 11 `.hdbindex` + 2 `.hdbsequence`
+ 2 `.hdbsynonym` + 2 `.hdbrole` + deploy config — all D7 (generated from the
live DB), plus 7 genuinely unaccounted (5 `.cds`, 1 `.hdbprocedure`, 1 `.hdbfunction`).

**A real collision the score found.** Two folders hold **two `.xsodata` each**
(`JB_SUPVR/JB_ALLJBPSTNG`, `JB_UNION_ADMIN/JB_JBPOSTPRTL`) and both map to that
folder's single `service.cds`. Without a decision the second silently overwrites
the first. Now reported as `SERVICE_COLLISION`; needs a merge-or-rename rule in
Phase 4.

**43 tests, zero dependencies, zero framework.**

### Next: Phase 2 — the calc-view pipeline

454 files, the 1:1:1:1 win, 100% path accuracy already proven. Needs:
`parse/calcview.js` (XML → columns, params, script), `emit/hdbcalcview.js`
(cleaned XML), `emit/hdbfunction.js` (TABLE_FUNCTION wrapper),
`emit/cdsproxy.js` (the `.cds` entity), plus the item 3/25 attribute fixes.
Copy from `migration-cleanup-toolkit/src/{parsers,generator}/`.

---

## 12. Phase 2 — parser done, and a finding that changes the scorecard

### Parser: `src/parse/calcview.js` — built on `fast-xml-parser`

Cross-validated against migration-cleanup-toolkit's proven regex parser over
**all 1,041 calc views in both corpora: 1,041 identical extractions, 0 differences**
(scenarioId, dataCategory, applyPrivilegeType, classification, logicalModelId,
description, viewAttributes, parameters, script).

So the library buys correctness on edge cases (XML comments containing markup,
CDATA) for zero behavioural change. **Keep it.** First and only runtime dependency.

**New corpus fact: all 1,041 calc views are `PURE_SCRIPT`** — 100%, across *both*
projects. The toolkit had measured 587 (Corpus B only); Corpus A's 454 now confirm it.
Generate-from-script is safe corpus-wide, not just for Corpus B.

### Generator: `src/emit/hdbfunction.js` — ported from the toolkit

Ported CJS→ESM along with `src/parse/sqlscript.js` (the segment scanner that
tells code from string from comment). Runs on all 453 Corpus A views, throws 0.
Do not "improve" it without re-running `score`.

Container path rule, derived empirically from the shipped function names:
`containerPath = flattenEntityName(<schema>.<neo dir path>)`, e.g.
`TECK_JOB_BIDDING_JB_ADMIN_CONSOLE_VIEWS`.

### ⚠ THE FINDING: the shipped Corpus A CF is NOT a content oracle

Diffing 453 generated table functions against the shipped ones gives 42
whitespace-only matches and 411 differences. Classifying them:

| Cause | Verdict |
|---|---|
| **`EMPIDBCK` column added, `NVARCHAR(30)` → `(100)`** | **Post-migration CF edit.** `EMPIDBCK` appears in **0 NEO files and 258 CF files.** It does not exist in the source. No tool could ever derive it. |
| `LOWER(a) = LOWER(b)` (checklist item 24) | Real transform gap: 380/454 NEO views already have `LOWER(`, 418/454 shipped do — ~38 gained it in migration |
| `from DUMMY` → `from "DUMMY"` | Real transform gap, 12 files |
| Blank line before `return :var_out;` | Cosmetic |

**Consequence for the plan:** content-level diffing against
`neo-to-cf-teck-jbd-backend` measures *post-migration drift*, not tool quality.
One added column alone touches 258 files. The reference is a valid oracle for
**structure** (paths, names, column counts, signatures) and an invalid one for
**text**.

So the scorecard stays structural — which is what it already does, and it scores
97.2%. Content fidelity must be measured differently: **faithfulness to NEO**
(does the generated SQL preserve the source's semantics), not identity with CF.
That is a round-trip/parse property, checkable without any reference tree.

### Next

- Add the two real transform gaps: item 24 `LOWER()` equality, and `DUMMY` quoting
- `emit/cdsproxy.js` and `emit/hdbcalcview.js` (the projection view + DataSource)
- Wire `neo2cf convert` with `--write` and patch output

### Decisions D10 / D11 (2026-09-06)

| # | Decision | Consequence |
|---|---|---|
| **D10** | **Do not apply `LOWER()` (item 24). Copy NEO exactly.** | The tool never edits comparison logic. Also drops `FROM DUMMY` → `FROM "DUMMY"` quoting, since unquoted `DUMMY` is valid HANA — two "gaps" became non-gaps. |
| **D11** | `EMPIDBCK` was a one-off, so the Corpus A CF stays a useful reference | Kept as a bug-catching reference for *structure*; see the caveat below |

**Necessary vs cosmetic — the line the generator holds.** These transforms stay,
because without them the output does not compile or does not run under CF:
strip the project's own schema qualifiers · `SESSION_USER` →
`SESSION_CONTEXT('APPLICATIONUSER')` · quote reserved-word aliases (`AS COUNT`) ·
append `return :var_out;` (0 of 1,041 NEO scripts have one). Everything else is
left alone.

### D11 caveat: `*BCK` is a family, not one column

Measured: **`ASSGIDBCK, EMPIDBCK, SPRIDBCK, SUPIDBCK, USRIDBCK`** — five columns,
**0 occurrences in NEO, 212 CF db files, 102 of 454 table functions.** A
systematic post-migration addition, not a single column.

### Text comparison against the CF is not a valid measure — confirmed twice

On the *clean* 352 functions (no `*BCK`), SQL bodies still differ in 250 cases.
Causes, all of them changes made **after** translation:

| Cause | Example |
|---|---|
| SQL keywords uppercased | `select … as COL` → `SELECT … AS COL` |
| Whitespace/comma reformatting | `PK_BDLID ,SEQID ,` → `PK_BDLID, SEQID,` |
| String literal case changed | `'Active'` → `'active'` |
| A second strippable schema | `"TECKR"."DSM_M_MSTDT"` also stripped — config, not code |
| `return` → `RETURN` | inconsistent even within the reference |

So the scorecard stays **structural** (97.2%). Content fidelity is measured as
*faithfulness to NEO*, which needs no reference tree.

### The generator is more correct than the reference — demonstrated

`TECK_M_get_BDRange` has `"TECK"."TECK_M_BDTYP"` inside a **SQL comment**:

```sql
--SELECT DISTINCT RANGE
--   FROM "TECK"."TECK_M_BDTYP" ORDER BY RANGE ;
```

Our output reports `schemasStripped: 0` — correct, the segment scanner skips
comments. The shipped CF stripped it anyway, i.e. a blind regex over raw text.
This is the whole reason the scanner exists, and it is now evidenced.

**No real generator bug was found.** Investigated and cleared.

### Phase 2 calc-view pipeline — COMPLETE

**60 tests.** One runtime dependency (`fast-xml-parser`).

| Module | Origin |
|---|---|
| `src/parse/calcview.js` | New, on fast-xml-parser. Cross-validated 1,041/1,041 against the toolkit's parser |
| `src/parse/sqlscript.js` | Ported from toolkit (segment scanner: code vs string vs comment) |
| `src/emit/hdbfunction.js` | Ported from toolkit |
| `src/emit/cdsproxy.js` | Ported from toolkit |
| `src/emit/hdbcalcview.js` | **New — the toolkit has no equivalent**, it only patched the assistant's output |

Ran across all 454 Corpus A calc views: **0 throws**, 454 CDS proxies, 454 calc views.

#### Structural fidelity: 349/353 = 98.9%, and the 4 misses are not ours

Excluding the 101 views carrying post-migration `*BCK` columns, generated calc
views match the shipped ones element-for-element in 349 of 353 cases. All four
remaining differences were traced and are **CF-side additions absent from NEO**:

| Difference | NEO | CF |
|---|---:|---:|
| `<snapshotProcedures/>` | 0 files | 2 files |
| `<comment>` inside a `<descriptions>` | 0 files | 2 files |

So **every** difference between our output and the shipped CF — `*BCK` columns,
keyword uppercasing, whitespace reformatting, `'Active'`→`'active'`,
`snapshotProcedures`, `<comment>` — is a change made *after* translation.
Faithfulness to NEO is effectively 353/353.

#### Deliberate divergences from the shipped CF

| We emit | Shipped CF | Why |
|---|---|---|
| `COL : Integer` | `COL : Integer64` | HANA `INTEGER` is 32-bit; `Integer64` describes it as BIGINT. The toolkit's map is right |
| `RETURNS TABLE` column order | attributes-then-measures | Order is semantically irrelevant in CDS; ours keeps the proxy and the function agreeing |

#### Corpus facts learned

- **All 1,041 calc views in both corpora are `PURE_SCRIPT`** (toolkit had measured Corpus B's 587 only)
- Corpus A has only **3 parameterised** views; the 222/587 figure was Corpus B's
- `snapshotProcedures` carry-through is implemented but **untriggered by either corpus** — defensive, covered by a test

### Next

- `emit/servicecds.js` + `service.js` (port from toolkit), and the `SERVICE_COLLISION`
  merge-or-rename decision for the 2 folders holding 2 `.xsodata`
- Wire `neo2cf convert --write` with patch output and the key-from-.xsodata pass
  (checklist item 5 — proxies currently emit no `key`, which is correct until the
  service layer is parsed)

---

## 13. Service layer + the conversion pipeline — DONE

**74 tests.** `neo2cf convert <neo-dir> -o <out-dir> [--write] [--force]` now
produces a complete CF tree from NEO alone.

### Reuse from the toolkit

| Module | Origin |
|---|---|
| `src/parse/xsodata.js` | **Ported** — entities, aliases, keys, `with`, navigates, associations, `create using` |
| `src/emit/servicecds.js` | **Ported** — measured fully deterministic, which is why the toolkit's AI tier refuses this artifact |
| `src/emit/servicejs.js` | **New** — the toolkit checks handlers but never authors this file |
| `src/convert.js` | **New** — the two-phase orchestrator |
| `src/core/write.js` | **New** — the output guards |

### Why the pipeline is two-phase

Information flows *backwards*: a CDS proxy's `key` columns are declared in the
`.xsodata` that projects it (item 5), and `service.cds` needs the proxy names the
calc-view pass produces. So: **parse everything, then emit everything.** Emitting
while walking would mean a missing key or a forward reference.

### Result on Corpus A — 1,569 files from NEO alone

| Role | Count |
|---|---:|
| `TABLE_FUNCTION_*.hdbfunction` | 454 |
| `.hdbcalculationview` | 454 |
| `db/cds` proxy `.cds` | 454 |
| `.hdbprocedure` | 169 |
| `service.cds` | 19 |
| `service.js` | 19 |
| **total** | **1,569** |

- **2 blocked** — both the known `SERVICE_COLLISION` (2 `.xsodata` in one folder)
- **58 warnings** — 33 `NO_KEY` (views no `.xsodata` projects, so no key derivable), 15 association-naming, rest minor
- **0 `PROXY_NOT_FOUND`** — every entity every service projects resolved to a real calc view
- **2 renames** — `91Efu5zcsYvGmdP` → `E91Efu5zcsYvGmdP`, `9UPBK9QDitgIuOp` → `E9UPBK9QDitgIuOp` (2 sites, one consistent name — the reference gave this alias two different names)

### Validated against the shipped CF

- **`service.js` import paths match character-for-character**: `../Library/handlers/…`
  and `../../../COMMON_View/Library/handlers/…`
- **`service.cds` `using` paths match character-for-character**, including the
  seven-level `../../../../../../../db/cds/…` climb — checklist **item 4
  satisfied by construction** rather than fixed afterwards
- 19 service pairs = 21 `.xsodata` − 2 collisions, matching the shipped count

Differences are all D8 developer additions: the shipped `service.js` also imports
`ExtendRecordlock`, `rateLimiter`, `roleAccess` and adds a `srv.before("*")`
block. None of it exists in NEO.

### Write guards — both tested and exercised

1. **Refuses to write into the NEO tree** — verified against a real attempt
2. **Refuses while a blocker stands** unless `--force`
3. Dry run is the default

Full run wrote 1,569 files / 2.7 MB to a scratch dir; the NEO tree was verified
untouched afterwards.

### Next

- `neo2cf score` should now compare the *emitted* tree rather than predicted paths
- The JS tier (Tier 1 AST transform) — `.xsjs`/`.xsjslib`, 88 files, 505 JDBC sites
- `SERVICE_COLLISION` needs a merge-or-rename rule (2 folders)

---

## 14. The JavaScript tier, part 1 — JDBC analysis — DONE

Built `src/transform/js.js` (parse/walk/splice) and `src/transform/db.js` (chain
analysis), plus `dbscan` to report the result. 32 new tests. Nothing is emitted
yet — that is the next step, and it is deliberately a separate module.

### The one design decision that matters

**The AST locates; the original text is edited by offset.** We never regenerate
source from the AST. Regeneration would reprint all 88 files in a printer's
style and throw away every comment, so a developer diffing the output against
the NEO original would lose their bearings on line one. `applyEdits(source,
[{start,end,text}])` splices instead, and refuses overlapping edits rather than
letting one transform silently win over another.

`acorn` is the second dependency. `migration-cleanup-toolkit` deliberately
avoided a parser and paid for it by only ever *reporting* (its `handlerjs.js`
says so in its own header). We rewrite, so the parser earns its place. All 209
corpus files parse with `allowReturnOutsideFunction` — XSJS really is ES5 plus
the `$` global.

### Analysis, not emission — one analysis, three consumers

`analyseDb()` returns a **chain** per statement: `{kind, sql, binds, columns,
reads, shape, perIteration, resolved, gaps, notes, nodes}`. The emitter reads
chains; the AI tier's FACTS block *is* the chain; a chain with gaps is a hole
for a human. Splitting analysis from emission is also what makes each half small
enough to test — and small enough for a 7B model to handle one at a time, which
is the architecture constraint the whole tool is built to.

### How resolution went from 26.4% to 69.6%

Every step was driven by reading what the corpus actually refused, never by
guessing:

| Step | Corpus A resolved |
|---|---|
| first working version | 26.4% |
| loop rule fixed — see below | 46.9% |
| fold `'SELECT A,' + ' B FROM T'` into one constant | 56.1% |
| alias unnamed SELECT columns in the SQL itself | 68.6% |
| fold `if/else` conditional binds | 69.3% |
| bound the result-set variable's lifetime | **69.6%** |

**The loop rule was wrong.** The first version flagged any bind inside a loop as
a batch — 374 of them. It isn't: hoisting the prepare out of a loop is ordinary
JDBC. What decides it is where the **execute** sits. `prepare; for(){ set; execute; }`
is one round trip per iteration and converts to a `cds.run` inside the same
loop (`perIteration: true`). Only `prepare; for(){ set; } execute;` accumulates
across iterations and is a real batch. The corpus contains **two** of those.

**Aliasing unnamed columns.** `SELECT count(*) FROM T` gives a result column
whose name HANA invents, so `getInteger(1)` has nothing to map to. Rather than
report 40 gaps saying "add an alias", the tool adds it: `count(*) AS COL1`. The
SQL is ours to rewrite, nothing outside the converted function sees those names,
and semantics are unchanged. It is recorded as a `note`, not hidden. `SELECT *`
is still refused — a star cannot be aliased, and naming columns we have not seen
is the guessing this tool does not do.

**Conditional binds fold only when provable.** `if (c) set(4,x); else setNull(4)`
becomes `c ? x : null` — but only when *every* statement in both branches is a
bind on that same statement. Corpus A has one where the `else` also calls
`logError(...)`; collapsing that would delete a side effect, so it stays a gap.
27 looked foldable by shape, 4 actually were.

### Two bugs worth remembering

1. **An array-aliasing bug emptied every bind list.** `foldConditionalBinds`
   returned the same array the caller then cleared before reading. It briefly
   showed 71.9% — the inflated number — because a chain with no binds has no
   bind gaps. Caught by a test asserting the canonical chain's binds, not by the
   corpus, which looked *better* while broken. **A metric that improves for an
   unexplained reason is a bug until proven otherwise.**
2. **Result-set variables had no lifetime.** Statement handles were bounded by
   the next `prepare` of the same name, but `rs` was not, so a chain claimed the
   *next* query's getters. Corpus B reported 51 `COLUMN_OUT_OF_RANGE`; Corpus A, which
   reuses `rs` less, reported 3 — which is exactly why a second corpus is worth
   keeping. Fixed with `nextAssignment()`; Corpus B went 51 → 0.

### The remaining 30% is honest

74 Corpus A / 79 Corpus B statements build their SQL at run time by string
concatenation. That is unresolvable statically by construction — and, worth
saying, most of them are SQL-injection sites in the NEO original. The tool
refuses them by design; Tier 2 or a human takes them.

`dbscan` also surfaces genuine NEO defects rather than hiding them: a
`getNString(14)` against a two-column SELECT, six statements prepared and never
executed, and six where the `?` count disagrees with the bound values.

### The measurement that matters

Corpus A 69.6%, Corpus B 68.2% — two unrelated codebases, 1.4 points apart. That
convergence is the evidence that ~69% is the deterministic ceiling for this
class of code rather than a Corpus A-shaped result.

---

## 15. The JavaScript tier, part 2 — emission — DONE

`src/transform/emitdb.js` turns a resolved chain into CAP code. 21 new tests
(127 total). The emitter reasons about nothing: it renders what §14's analysis
already decided, and where the analysis refused, it leaves the NEO code exactly
as it found it under a `NEEDS HUMAN REVIEW` banner listing the gap codes.

```
conn  = $.db.getConnection();              →  (gone)
q     = 'SELECT A, B FROM T WHERE C = ?';  →  (gone, folded into the call)
pstmt = conn.prepareStatement(q);          →  (gone)
pstmt.setNString(1, x);                    →  (gone, folded into the binds)
rs    = pstmt.executeQuery();              →  rs = await cds.run(`…`, [x]);
while (rs.next()) {                        →  for (const rsRow of rs) {
  out.push(rs.getNString(1));              →    out.push(rsRow.A);
```

### Measure the shapes before writing the code

Before writing a line I counted how the statements are actually embedded, so no
fallback got built for a case that does not occur. Across both corpora: prepares
are only ever an assignment statement (305) or a sole declarator (101) — never a
multi-declarator; getters appear only in expression position, so replacing the
call node works everywhere without special cases. That measurement is why the
emitter is small.

### The finding that reset every number

The leak check — *a file where every statement converted should contain no JDBC
at all* — caught it. Files were reporting "all converted" while still full of
`prepareStatement`. The analyser required the connection to be a plain
identifier:

```js
if (obj.type !== 'Identifier') return;    // ← silently skipped the statement
```

But two thirds of the corpus reaches the connection through a parameter object:
`param.connection.prepareStatement(query)`. **370 of Corpus A's 673 prepare sites
(55%) and 837 of Corpus B's 1,123 (75%) were never seen at all** — not unresolved,
*invisible*. Fixed with `refPath()`, which keys a handle on its whole dotted path
(`rs`, `param.connection`, `this.stmt`) and returns null for anything it cannot
name, so an untrackable handle is reported instead of dropped.

| | before | after |
|---|---|---|
| Corpus A prepare sites detected | 303 of 673 | **673 of 673** |
| Corpus B prepare sites detected | 286 of 1123 | **1123 of 1123** |
| Corpus A statements converted | 210 | **342** |
| Corpus B statements converted | 192 | **510** |
| Corpus A "resolved" rate | 69.6% | **50.8%** |

**The rate went down and the tool got better.** 69.6% was the resolution rate
over the 45% of statements it could see; 50.8% is the rate over all of them, and
63% more statements now convert. Any percentage whose denominator is "what the
tool noticed" is worth nothing — this is the second time in two sessions that a
metric improved because something was broken (§14 has the first). **When a number
moves in your favour, find out why before believing it.**

### The check that has to exist

`dbscan` now converts each file and re-parses the result. A conversion producing
JavaScript that will not load is worse than no conversion, and this catches it
here rather than when the CAP app fails to start. Both corpora: **every rewritten
file parses**, except three that carry a pre-existing NEO defect (below).

The stronger check during development was: *a file where nothing was skipped must
contain no JDBC call in its output AST*. Text search is useless here — it matches
commented-out code and JavaScript's own `Date.getDate()`. Walking the output AST
found the last real bug: a chain taking its rows from a separate `getResultSet()`
call reported itself resolved while nothing was rewritten. One site per corpus,
so it is now refused (`DEFERRED_RESULT_SET`) rather than special-cased.

### Deliberate decisions

- **Async is derived, not guessed.** `await` makes its function `async`, which
  makes every caller need `await`, transitively over the file's call graph.
  Functions that become async and are reachable from other files are returned by
  name so cross-file callers can be fixed. The strategy doc notes missing awaits
  are what the hand migration most often got wrong, and they fail silently.
- **The comment that names a parameter follows it into the bind array.** NEO
  writes `setNString(9, x); // Level 1 Department Code`. Those comments are the
  only place the parameter names exist, so they are carried onto the array
  entries. The generated call is more readable than the JDBC it replaced.
- **Connection handling is removed only when the whole file converted.** A
  statement left for a human still needs the connection it opens.
- **`if (conn) conn.close();` takes its guard with it.** Deleting the statement
  alone leaves a dangling `if` — a syntax error. This was found by the re-parse
  check, not by reading.
- **`CALL "S.PKG::proc"(?)` is flattened; `CALL SYS.X(?)` is not.** The `::` is
  what distinguishes a NEO repository path from a real schema-qualified system
  call. The flattening uses the same `flattenCallPath` as the procedure emitter,
  so a handler and `db/src` agree on the name.

### Defects the conversion exposes

Three files declare the same function twice. Legal in an XSJS script — the
second silently wins — and a `SyntaxError` in an ES module, so it only surfaces
after conversion. Which body was meant is not something to guess: the emitter
flags it at the second declaration and `dbscan` reports it. Also surfaced: a
`getNString(14)` against a two-column SELECT, six statements prepared and never
executed, and 25 where the `?` count disagrees with the values bound.

### What is left, honestly

292 Corpus A / 475 Corpus B statements build their SQL by concatenating run-time values.
Unresolvable statically by construction — and most are SQL-injection sites in the
NEO original. That is the AI tier's job, and the chain object is already the
FACTS block it needs.

---

## 16. `$.import` → ES modules, and one composer for all transforms — DONE

`src/transform/imports.js` plus `src/transform/file.js`. 14 new tests (141 total).

### Composition, not a chain of rewrites

`transformFile` parses once and every pass contributes *edits*, spliced in
together at the end. That is not only cheaper than re-parsing between passes —
because `applyEdits` sees all of them at once, **two transforms claiming the same
bytes is caught as the bug it is** instead of one silently winning. `emitdb.js`
became `dbEdits(ctx)`; `imports.js` is `importEdits(ctx)`; async propagation runs
last over the combined result.

### Reading the two halves together

NEO splits an import across two statements, and neither half is enough on its own:

```js
$.import("TECK.Env_Config", "CommonUtil");        // says where the package ends
var libEnvAth = $.TECK.Env_Config.CommonUtil;     // says what to call it
```

The registration is the *authority on where a package name stops and a library
name starts*. `$.TECK.JOB_BIDDING.EncryptionDecryption.AES.AESENCODEDEODE.CryptoJS`
is a member of a library, not a deeper library, and only the matching `$.import`
says so — the path alone cannot. Longest registered prefix wins.

The specifier is computed through `targetsFor` + `importSpecifier`, the same
layout functions the rest of the tool uses, so it is derived rather than guessed.

### Validated against the shipped CF

Of the 105 imports generated for files that have a shipped counterpart:

| | |
|---|---|
| same alias, same target | 50 |
| same target, imported by name rather than whole-module | 36 |
| the hand migration dropped the usage entirely | 19 |
| **pointing at the wrong file** | **0** |

Zero wrong targets is the number that matters. The 36 are a style difference —
the hand migration wrote `import { ErrorHandling } from …` where NEO used a
whole-module alias — and the converted `.xsjslib` emits **both** `export default
{ … }` and `export { … }`, matching what the shipped libraries do, so either
import style resolves. The 19 are functions the hand migration rewrote, the same
class of edit as §12's `*BCK` columns.

### Two bugs, both from the same blind spot

1. **Member property names were counted as taken bindings.** `used` collected
   every `Identifier` node, including the `.CommonUtil` in `$.TECK.Env_Config.CommonUtil`
   — so the generated import was renamed `CommonUtil_` to avoid colliding with
   the very expression it was replacing. Property names and object keys are not
   bindings; they are now skipped.
2. **A zero-width insertion at a deletion's end boundary was swallowed.** The
   filter that drops edits inside removed ranges used a span test, so an `async `
   inserted at exactly `function f`'s start was judged "inside" the statement
   deleted immediately above it. The function lost its `async` and the file
   stopped parsing. An insertion is a point, not a span: it now belongs to the
   code that follows it.

Both were caught by the re-parse check, not by reading the code. That check has
now paid for itself three times.

### `dbscan` checks every file

It previously only re-parsed files that had a database chain, so an import-only
conversion was never verified. It now converts and re-parses **every** library
file. Both corpora: every rewritten file loads except the three carrying the
pre-existing duplicate-declaration defect.

---

## 17. The request boundary — DONE

`transform/request.js` (540 lines), 25 tests. `$.request` / `$.response` /
`$.session`, the entry function, and what a `.xsjs` exports.

### The "hard" part turned out not to exist

§0 had this down as the one remaining chunk that needed a *judgement per file*
rather than a rewrite rule, on the reasoning that a `.xsjs` has `req` and a
`.xsjslib` does not, so the same idiom converts two ways. Measuring first
dissolved it, in two steps.

**Step one — the extension already sorts them.** Over both corpora:

| | `.xsjs` | `.xsjslib` |
|---|---|---|
| `$.request` | 184 | **0** |
| `$.response` | 745 | 12 (5 Corpus B files) |
| `$.session` | 2 | **57** |

`$.request`/`$.response` are an entry-point idiom and `$.session` is a library
one. There is no file where the question is genuinely open.

**Step two — CAP answers the rest itself.** The real difficulty was not the file
kind, it was that roughly a third of the `$.request`/`$.response` sites sit in
*helper* functions the entry point calls, where a `req` parameter is not in
scope. CAP keeps the current request in async-local storage as `cds.context`,
reachable from anywhere including inside a library. So: `req` where we know it
is bound, `cds.context` everywhere else, and both name the same object. The
first draft emitted `req` unconditionally and produced a `ReferenceError` in
every helper — caught by converting one real file and reading it, which is the
argument for always doing that before trusting a pass.

`cds.context.reject(…)` outside the entry function raises `REJECT_OUTSIDE_ENTRY`
(34 sites): it is the inbound request for a handler CAP invoked, but not for one
reached service-to-service. That is a real caveat and it is stated rather than
hidden.

### What the dispatch collapses to

NEO routes by hand — `switch ($.request.method)` inside a `processRequest()`
called at the bottom of the file. **53 of the 54 method switches in the corpus
have exactly one real case**, so the collapse is deterministic; the two-case one
gets `MULTI_METHOD_DISPATCH`. CAP routes by event name, so `req.event` is the
action name and never `"POST"` — which means in NEO's own dispatch the `default:`
405 branch was the only reachable one. The shipped CF says the same thing in a
hand-written comment on the two handlers we can compare against.

**57 of 110 `.xsjs` have an entry point** — one top-level call naming a function
declared in the file. The other 53 have theirs commented out (they were driven
by an `.xsjob`, out of scope per D6) and get `NO_REQUEST_ENTRY` rather than a
guess.

### Two bugs the corpus found that the tests would not have

1. **A leaf rewrite inside a bind value was silently lost.** The db pass *moves*
   a bind value out of its `setNString(1, …)` and into `cds.run`'s array, then
   deletes the statement it came from — taking any edit another pass had made
   inside it with it. So `pstmt.setNString(1, $.request.parameters.get("EMPID"))`
   became `cds.run(sql, [$.request.parameters.get("EMPID")])`. Fixed by running
   db **last** and giving it `ctx.inlineRewrites`, which `render` replays into
   the copy. The `$.import` pass had the same latent bug.
2. **`review()` backing up over the indent collided with the switch collapse.**
   A `NEEDS HUMAN REVIEW` comment for the first statement of a collapsed case
   started before that statement's line, inside the range the collapse had
   already claimed. Two files failed to emit at all. Comments now insert *at*
   the statement.

Both were caught by `applyEdits` refusing the overlap rather than picking a
winner — the design rule earning its keep for the second time.

### Result

| | Before | After |
|---|---|---|
| files rewritten (both corpora) | 172 | **199** |
| rewritten files that load | 169 | **195** |
| `$.request`/`$.response`/`$.session` sites in the output | ~1,000 | **66**, each with a named finding |

The four non-loading files each declare a function twice — legal in a sloppy-mode
XSJS script, a `SyntaxError` in an ES module. NEO defects the conversion exposes,
reported with both line numbers.

The AST leak check from §15 was rerun in this shape: *a file whose request
findings are empty must contain no `$.request`/`$.response`/`$.session` in its
output AST.* It passes on both corpora. Text search cannot do this job — the
idioms appear in comments, including the ones this pass writes.

---

## 18. Handlers wired into `convert` — DONE

`.xsjs`/`.xsjslib` now emit through the main pipeline. Corpus A: **1,656 files, 87
handlers.** Corpus B: **2,175 files, 118 handlers.** `targetsFor` already knew
`KIND.LIBRARY`, so this was a phase-A collect and a phase-C loop.

Three things were worth doing properly rather than quickly.

### The re-parse check moved into `transformFile`

`dbscan` re-parsed its output; `convert` would not have. That is backwards — the
command that *writes files* is the one that must not write a file the JavaScript
parser rejects. It now lives in `transformFile`, so every caller gets it and
`scan.js` got shorter. A handler that does not parse is reported and **not
emitted**: a missing file with a blocker beats a file that breaks `cds watch`.

### `path.dirname` returns "." — a real bug, found by comparing paths

Corpus A keeps four `.xsjs` at the root of the tree, which produced
`srv/lib/TECK/./handlers/GetTableData.js`. Latent in the calcview, procedure and
service rules too. `layout.js` now joins segments through a helper that drops
empties.

### Two checks the tool can run on its own output

Neither needs a reference tree, which is the point — they will keep working on a
customer codebase nobody has hand-migrated.

1. **Every relative import resolves to a file we also emit.** 421 of 429. The 8
   that do not point at a foreign schema (`ALGOMA`, `COEDM`) or at the one
   library withheld for not parsing; all 8 already had their own finding.
2. **Every function an `.xsodata` wires up is exported by its handler.**
   `generateServiceJs` now returns its bindings and `transformFile` its export
   names, so `convert` can cross-check them. **18 fail** — and grepping NEO
   confirms those functions do not exist in the library at all. The `.xsodata`
   wires an entity to nothing; it did so in NEO too, and CAP only says so at
   startup. New finding: `HANDLER_EXPORT_MISSING`.

### On `score`'s 65.9%

`score` counts a predicted file the reference lacks as a miss, which is wrong for
handlers. Compared directly against the shipped Corpus A CF: **57 of 87 land on the
exact path, 0 land in the wrong folder.** The other 30 are NEO files the hand
migration did not carry across — four `test*.xsjs`, the four root-level
`GetTable*.xsjs`, and similar. Of the 6 handlers the shipped CF has and we do
not, 5 do not exist in NEO (the CF-only utilities of D8) and the 6th is the
withheld duplicate-function library. Fixing `score` is item 3 above.

---

## 19. The destination calls — DONE

`transform/http.js` (411 lines), 17 tests. **59 of 63 outbound calls convert**
(Corpus A 20/20, Corpus B 39/43). The 4 refusals are all in one file and all honest.

NEO spreads one call over six statements and three variables; CAP writes it as
one `executeHttpRequest`. The chain is anchored on `new $.web.WebRequest` rather
than on the destination, because a file typically reads one destination and then
builds several requests against it — the request creation is the thing there is
one of per call.

The `readDestination("TECK.Env_Config", "CPI_TECK")` package argument is
**dropped**: a NEO destination is named inside an `.xshttpdest` package, a CF one
is a flat name in the destination service. The shipped CF confirms it.

### The one that would have been silently wrong

`Common/CreateFolder.xsjslib` assigns `new $.web.WebRequest` four times to one
variable — one per `if (mName === …)` branch — and then sends it once. The first
version of the pass resolved the *last* of the four and emitted its URL, which
would have routed GRV, DSM and TLW traffic to the CMP endpoint. Working code, no
error, wrong behaviour. It is now `HTTP_REQUEST_CONDITIONAL`, and it is the only
refusal left in either corpus.

That is the whole argument for the "measure, then look at the output" habit: the
rate went *down* when this was fixed, from 84.1% to 82.5%, and that was the
improvement.

### Four bugs the corpus found

1. **`memberCalls` was file-wide, not scoped.** XSJS leaks undeclared variables
   to the global object, so two functions in one file routinely both use `dest`,
   `client` and `req` — and `getAccessToken` saw the `client.request(req, dest)`
   belonging to `GetAccessToken`, refusing both as `HTTP_MULTI_SEND`.
2. **`RESPONSE_UNNAMED` was not a real problem.** A bare `client.getResponse();`
   throws the response away — fire-and-forget, which `await executeHttpRequest(…)`
   as a statement expresses exactly. The shipped CF does the same. Six refusals
   became conversions.
3. **Destinations and clients read once at module level were invisible**, because
   the lookup only walked the enclosing function. Widening it to module scope
   took Corpus A from 90% to 100%. The first attempt tested `!enclosingFunction(n)`,
   which is never true — that helper returns the `Program` for top-level code.
4. **THE COMPOSER BUG.** Two chains legitimately remove the same statement — one
   `dest = readDestination(…)` shared by two calls — producing two *identical*
   deletion edits. `file.js` then asked "is this edit inside a removed range?"
   and each copy answered yes about the other, so **both were dropped and the
   statement stayed in the output**. Latent since the JDBC tier; found by the
   leak check, not by reading. Fixed by deduping before computing the removed
   ranges.

### Also

`convert` now raises `DEPENDENCY_REQUIRED` when any handler needs
`@sap-cloud-sdk/http-client` — the NEO tree never depended on it, and the
alternative is a "Cannot find module" on the first `cds watch`.

---

## 20. The SQL that was never dynamic — DONE

**Corpus A 50.8% → 86.6%. Corpus B 45.4% → 79.7%.** No model involved. This section is
the case for measuring before building, because the plan said to build an AI
tier here and the measurement said not to.

### What the 767 SQL_DYNAMIC statements actually were

The next task on the list was the AI tier, aimed at the 767 statements the JDBC
analyser refused with `SQL_DYNAMIC`. Before writing a prompt, one question:
*what would a validator have to check?* If it can check the answer that
precisely, the transformation is deterministic and does not need a model.

So the 767 were classified by **where the interpolated value sits in the SQL**,
which is decided by counting quotes from the start of the statement:

| Position | Sites | What it is | Conversion |
|---|---:|---|---|
| inside `"…"` | **605** | a table or column name | interpolate — SQL cannot bind an identifier |
| DDL, unquoted | 68 | `GRANT <role> TO <user>` | interpolate — DDL takes no parameters at all |
| inside `'…'` | 44 | a value | a `?` bind |
| a call operand | 33 | `x.toUpperCase()` | — |
| bare | 15 | `LIMIT <n>`, IN-lists | — |

**79% of "dynamic SQL" is a table name.** No amount of parameterising converts
it, because no SQL dialect has ever allowed a bind parameter in an identifier
position. The conversion is an interpolation into a template literal, and it is
completely deterministic:

```js
pstmt = conn.prepareStatement('SELECT ID,PAYLOAD FROM "' + after + '"');
  →  rs = await cds.run(`SELECT ID,PAYLOAD FROM "${after}"`);
```

Identifier and DDL holes now convert (673 of 767). Value holes are still
refused: turning one into `?` means inserting it into an existing bind order,
and getting that wrong is silent. Not attempted, so not claimed.

### The finding it raises, and why it is not a fix

Every interpolation gets `SQL_IDENTIFIER_INTERPOLATED`, naming the expression:

> `after` names a table or column, so it is written into the SQL text rather
> than bound — SQL cannot parameterise an identifier.
> **Fix:** check that `after` cannot carry a caller-supplied value.

This is a real SQL-injection surface and it is stated rather than papered over.
The shipped CF added an `assertHanaIdentifier` helper for exactly this — but
that helper is a CF-only utility the developer wrote later, and **D8 says the
tool migrates what is in NEO and does not scaffold**. So: convert faithfully,
name the risk, let the developer decide. In the corpus at least one is genuinely
caller-controlled (`after = param.afterTableName`), so the finding is not
theatre.

A `note`-level gap was added for this: something true about a statement that
*did* convert. `resolved` ignores notes, and `dbscan` lists them under
**CONVERTED, BUT WORTH READING** rather than under the refusals, where they were
badly misleading — 243 of Corpus A's "refusals" were conversions.

### Three bugs found on the way

1. **`convert` never reported a single JDBC refusal.** Chain gaps reached only
   `dbscan`, which reads chains directly; `transformFile().findings` never
   carried them. So the command that *writes the files* was silent about which
   statements it had left alone. Fixed at the source — `transformFile` now
   returns them and `scan.js` stopped double-reporting.
2. A literal NUL byte got written into `db.js` as a placeholder and made the
   file read as binary to `grep`. Replaced with the `__NEO_HOLE_n__` sentinel
   the emitter needs anyway. Checked: the sentinel never survives into output,
   and never lands in a column name (verified across all 666 interpolations).
3. `statementKind` now classifies 285 Corpus A statements as `select` that were
   `unknown` before — the SQL became readable, so column analysis applies to
   them too. `COLUMN_OUT_OF_RANGE` did not move, which is the evidence that the
   newly-readable SELECT lists are being read correctly.

---

## 21. Two `.xsodata` in one folder, and an honest scorecard — DONE

### SERVICE_COLLISION was not a collision

Two folders hold two `.xsodata` each, and both mapped to one `service.cds`. The
tool emitted the first and blocked on the second. The shipped CF shows the
answer: **a `.cds` file holds as many `service` blocks as you like**, each with
its own path, and one `service.js` wires the handlers for all of them because
every alias is a distinct hash. Our merged output now matches the shipped
`service.cds` block-for-block and `service.js` handler-for-handler.

The aliases do overlap — 13 of the JB_JBPOSTPRTL pair's appear in both files —
but every one names the same entity and the same `create using`, so they are
duplicates, not conflicts. `ALIAS_COLLISION` now fires only when a repeated
alias is served by a *different* function, and only for entities that produce a
handler at all: a read-only projection appearing in two service blocks is not a
clash, which is what the first, over-eager version got wrong (18 false blockers).

**Both corpora now convert with zero blockers.** `convert` exits 0.

### score: 97.2% → 99.9%

`score` counted a predicted file the reference tree lacks as a miss. For 30 Corpus A
handlers and 13 procedures that is measuring *their* decisions, not ours — the
hand migration simply did not carry those NEO files across (four `test*.xsjs`,
the root-level `GetTable*.xsjs`, and so on).

A `DROP` column now separates them, and they are left out of the hit rate. The
check must run **before** the folder test, because a dropped file usually shares
a folder with files that were kept, which made it read as a naming-rule failure
when the naming rule was never consulted.

| | before | after |
|---|---|---|
| srv handler .js | 65.9% | **100.0%** — 0 wrong folder, 0 wrong name, 30 dropped |
| .hdbprocedure | 92.3% | **100.0%** |
| TOTAL | 97.2% | **99.9%** |

One genuine miss remains, a single `TABLE_FUNCTION_*.hdbfunction` name.

---

## 22. The binds that were never missing — DONE

`BIND_COUNT_MISMATCH` was 128 sites and the note beside it read *"probably a NEO
defect."* It was the largest single refusal left, and it was not a defect.

### Site count is not value

Before touching it, one measurement, and it should have been made much earlier:
**a statement converts only when every blocker on it is gone, so what a refusal
is worth is not how often it fires but how often it fires alone.** Across both
corpora, 318 refused statements:

| Refusal | Raw sites | Chains where it is the ONLY blocker |
|---|---:|---:|
| `BIND_COUNT_MISMATCH` | 128 | **117** |
| `SQL_DYNAMIC` | 101 | 96 |
| `READ_OUTSIDE_ROW` | 49 | 44 |
| `BIND_CONDITIONAL` | **219** | **19** |
| `BIND_BATCHED` | **59** | **1** |
| `MULTI_EXEC` | 14 | 0 |

The two the previous plan named as the AI tier's main targets are the two worth
least. `BIND_CONDITIONAL` fires 219 times on 41 statements — one statement binds
23 parameters conditionally — and 22 of those 41 are blocked by something else
as well. `BIND_BATCHED` is worth **one statement**. Fixing either perfectly
would move the rate by about a point.

### What the mismatch actually was

116 of the 117 are `prepareCall`. The direction is almost always the same: one
more `?` than there are binds.

```js
cstmt = conn.prepareCall('CALL "…::TECK_prCreateSummary"(?,?,?,?,?)');
cstmt.setInteger(1, …); … cstmt.setNString(4, …);   // four
cstmt.execute();
SUMID = cstmt.getInteger(5);                        // the fifth is read back
```

The fifth `?` is an **OUT parameter**. That is ordinary `CallableStatement`
usage, not a bug — the rule "one bind per placeholder" is simply false for a
CALL. The procedure declares it, and the procedure is in the NEO tree:

```sql
PROCEDURE "TECK"."TECK.JOB_BIDDING.COMMON_View.Procedures::TECK_prCreateSummary"
( IN JOBID BIGINT, IN ACTTP NVARCHAR(200), IN NOTES NVARCHAR(5000),
  IN EMPID NVARCHAR(30), OUT OPK_BDSID BIGINT )
```

And the shipped CF says what to do with it — read the OUT value off the result
**by name**:

```js
const result = await cds.run(`CALL …_TECK_prCreateSummary(?,?,?,?,?)`, [ … ]);
return result.OPK_BDSID;
```

The name is the one thing the JavaScript cannot supply. `getInteger(5)` knows a
position; CAP wants `OPK_BDSID`. So `src/parse/procsig.js` reads the signature
off the `.hdbprocedure` — 372 of them across the two corpora, all parsed — and
`db.js` consults it. Our output for the file above:

```js
const callResult = await cds.run(`CALL TECK_…_TECK_prCreateSummary(?,?,?,?,?)`, [
  parseInt(funtionSummary.JOBID, 10),
  funtionSummary.ACTTP,
  funtionSummary.NOTES || '',
  funtionSummary.EMPID || '',
]);
SUMID = callResult.OPK_BDSID;
```

**Corpus A 86.6% → 90.2% (607/673). Corpus B 79.7% → 87.4% (981/1123).** 104 statements,
118 OUT reads rewritten. No model.

### Four refusals kept, and why

Rule 4 again — the conversion only happens when all four hold, and each failure
has its own name:

- **No signature, or an arity that disagrees** — the statement keeps
  `BIND_COUNT_MISMATCH`. 9 sites remain: a procedure in a foreign schema
  (`COEDM`), and one CALL whose `?` count does not match any declaration.
- **A getter reads a position the procedure declares `IN`** — `CALL_OUT_UNKNOWN`.
  One site, and it is a genuine NEO bug: the file prepares `cstmt8`, then reads
  `cstmt2.getNString(2)`. The intended read was `cstmt8`'s OUT parameter.
- **OUT parameters that are not trailing** — the bind array's positions would
  stop agreeing with the `?` they fill. There is not one in either corpus, and
  refusing costs nothing.
- **An OUT value read outside the block the execute sits in** —
  `CALL_OUT_OUTSIDE_SCOPE`. The name we introduce is a `const`; a read from
  outside its block parses fine and throws at run time. Same trap as
  `READ_OUTSIDE_ROW`, caught the same way, and a check over the emitted trees
  confirms all 101 declarations and 216 references are in scope.

### The rule this makes explicit

Twice now a refusal has been read as "the NEO code is wrong" when the tool was
applying a rule that does not hold: §20 assumed every run-time value in SQL
wanted a bind parameter, and this one assumed every `?` wanted one. **Before
building anything for a bucket of refusals, count how many statements it is the
only blocker on, then read five of them.** Both times that took under an hour
and both times it replaced the planned work with something smaller and
deterministic.

---

## 23. The compiler as oracle — DONE

The tool emitted 1,656 files and reported no blockers. It had never once been
asked whether CAP would accept them. The shipped CF has `@sap/cds` in its own
`node_modules`, so:

```bash
node bin/neo2cf.js convert <neo> -o out --write
cd out && <shipped-cf>/node_modules/.bin/cds build --production
```

**259 errors on Corpus A, 64 on Corpus B.** None of them were visible to any check we
had, because every one produced a file that looked exactly right.

### First, the project had to exist

`cds compile db srv` answered *"Couldn't find a CDS model"* — we emit `db/` and
`srv/` and nothing else, and CAP does not walk `srv/lib/**` looking for
services. So `src/emit/project.js` now emits the shell, every part of it derived:

| File | Derived from |
|---|---|
| `package.json` | the bare specifiers the emitted handlers actually import — measured across both trees: `@sap/cds` and, where a destination call converted, `@sap-cloud-sdk/http-client`. Plus `"type": "module"`, because `$.import` became `import` |
| `srv/index.cds` | one `using` per emitted `service.cds`. **Without it the services are invisible** |
| `mta.yaml` | modules and resources; the destination service only when something calls one; one `existing-service` per foreign schema the tree reads |
| `xs-security.json` | `xsappname` and **nothing else** |
| `db/package.json`, `db/undeploy.json` | the HDI deployer the `hdb` module runs |

This is close to D8 and the line drawn is deliberate: D8 is about *code the
developer wrote* — validation helpers, rate limiting, the error-logging
`srv/server.js`. A `package.json` is not that; without it none of the converted
files can be installed, built or started. What is still not emitted: the nine
role scopes in the shipped `xs-security.json`. NEO's `.xsprivileges` declare one
privilege, `Execute`. The scopes came from the launchpad design, and inventing
an authorisation model is not migration.

### Then five defects, each invisible until now

**1 · `Duplicate definition of artifact` (112 errors).** A NEO service is
identified by its *path*; a CAP service name is global. Two folders each hold an
`EMP_JBPOSTPRTL_gp88h82pwzbf0p47.xsodata`, and Corpus A has a second such pair. The
developer hit this by hand and resolved it by appending `123` to one name.
`assignServiceNames` used to qualify **both** members of a colliding group with
the first folder segment that tells them apart — symmetric, because renaming
only the second would make the name depend on scan order. The URL changed, so
each one got a `SERVICE_NAME_COLLISION` finding naming the new path. 4 on Corpus A,
28 on Corpus B.
>
> **Superseded 2025-09** — a caller already reaches the NEO name and path; this
> tool renaming either to solve an internal bookkeeping problem breaks the UI
> that calls it, silently, which is worse than the compile error it was
> avoiding. `assignServiceNames` now always returns the NEO name unchanged; a
> collision is still reported as `SERVICE_NAME_COLLISION`, but nothing is
> renamed. See `emit/servicecds.js` and `docs/ARCHITECTURE.md`.

**2 · `Element "BDLNT" has not been found` (111 errors).** An `.xsodata` names
columns in `with(…)` that its calc view does not have — `BDLNT`, `BDLTP`,
`PDPNM`, `PDPID` appear in no view in the tree. NEO never checked; CAP stops.
The column is dropped with an `XSODATA_COLUMN_DROPPED` finding, the same
treatment `.xsodata` *keys* already got. 39 on Corpus A, 38 on Corpus B. (The shipped CF
sidestepped this by dropping the `with(…)` restriction entirely and exposing
every column of the view — which compiles, and exposes more than NEO did.)

**3 · `Duplicate definition of top-level name` (26 errors).** §21 merged two
`.xsodata` in one folder into one `service.cds` with two `service` blocks. Each
block also emitted its own `using` lines, and a `using` may be declared once per
*file*. The emitter now returns `usings` and `serviceText` apart, and the caller
writes one deduped header.

**4 · `No artifact has been found with name "Integer16"` (64 errors, Corpus B).**
The proxy type map rendered `SMALLINT` as `Integer16`. **There is no such CDS
type** — it is `Int16`. This module is ported from the toolkit and carries a
"do not retune" warning, and the mapping had a documented corpus count beside
it. It was still wrong, and nothing caught it because the type only had to look
like a type. Corpus A has no SMALLINT column, which is why one corpus is not enough.

**5 · `Expected entity to have a primary key` (3 errors, at build not compile).**
A projection carries a key only if it lists *every* key of the entity it
projects on. One calc view is keyed `WFHID` by one `.xsodata` and `WFHNO` by
another; the proxy gets both, a service listing one of them has a partial key,
and CAP treats a partial key as none. The projection now restates the key its
own `.xsodata` declares.

### Result

```
teck  cds build --production  exit 0   0 errors  0 warnings
icbc  cds build --production  exit 0   0 errors  0 warnings
```

Both produce `gen/srv` and `gen/db` — the two paths `mta.yaml` deploys.

### The lesson, which is the same one as §20 and §22

Three of these five had been reviewed, tested and shipped. The tool's own checks
— re-parse every emitted `.js`, resolve every relative import, walk the output
AST for leaked idioms — are all checks *we invented*. None of them could know
what `Integer16` is. **Where a real compiler, parser or runtime for the target
exists, run the artifact through it before believing the artifact is right.**
The tests here are unit tests because `cds` is not a dependency of this tool,
but every one of them is a transcript of a compiler error.

---

## 24. Letting the branch choose, and a scorecard that reads the output — DONE

Two items from §0's list, and the first one measured its own way out of the AI
tier for the third time.

### `BIND_CONDITIONAL`: the branch was never the problem

The plan said 81 of the 120 remaining sites were nested `if`s and therefore a
nested-ternary fold. That was built — `bindDecisionTree` reads an `if` as a
decision tree over binds at any depth — and it moved almost nothing. Reading
five of the failures said why:

```js
if (rs.getNString(19) && record.JPSTS === '6') {
    cstmt.setNString(19, rs.getNString(19) || '');
} else {
    cstmt.setNull(19);
    logError(pstmtErr, srvName, record, "CLOSR can't be null …");
}
```

The branch does not only choose a value — it also logs. No conditional
expression can hold that, so every fold refuses it, and this is the *common*
shape, not the exception. The classifier that produced the "81 nested ifs"
figure had only looked at the innermost `if`'s two branch lists.

The answer was to stop trying to remove the `if`. It is not choosing control
flow, it is choosing a **value**, so it can stay exactly where it is:

```js
let bind19;
if (…) { bind19 = rs.getNString(19) || ''; }
else   { bind19 = null; logError(…); }
await cds.run(`…`, [ …, bind19, … ]);
```

This is JDBC's own semantics restated: whichever assignment runs last before the
execute is the value that gets bound, exactly as the last `setX` won before.
Nothing is reordered, no branch is lost, and it works for every shape the fold
refuses — separate `if`s, `else if` chains, a plain overwrite. Refused only when
a bind sits in a loop the execute is not in (that is `BIND_BATCHED`, values
accumulating, not a choice), when the setter is not a statement of its own, or
when it is not in the same block as the execute, which is where the `let` goes.

**Corpus A 90.2% → 90.8%. Corpus B 87.4% → 89.4%.** `BIND_CONDITIONAL` is now **gone
from Corpus A entirely**, and its ceiling across both corpora fell from 27 chains to
**1** — the 99 sites that remain are all on chains blocked by something else.
The ternary fold was kept for the pure `if (c) set(4,a) else setNull(4)` case,
where it still reads better than a spilled variable.

Two things this exposed:

- **The overlap message was useless.** `Overlapping edits at offset 4232` and
  nothing else. It now prints both edits and the source each covers, and the
  first time it did, the cause was obvious in one line. Worth having done years
  ago.
- The first spill replaced the whole setter call with a rendered value, which
  overlapped the column-read rewrite already inside that value. The fix is to
  **bracket** the value instead of replacing it — `[callStart, valueStart) →
  "bind19 = "`, `[valueEnd, callEnd) → ""` — so the value never moves and every
  other pass's edits inside it still land. Comments and spacing survive too.

### `score` now reads what was written

It scored `targetsFor()`'s *predictions*. Those matched the emitted files for a
long time and then stopped: a NEO file whose conversion fails produces no output
at all, and the old scorecard still predicted its path — and could still score
it as a hit against a reference file that exists. Corpus A had exactly one, Corpus B
three: the libraries withheld for declaring a function twice.

`score` now runs `convert()` and compares the files it actually wrote, with a
**NONE** column for NEO files the run produced nothing for. That is also one
source of truth for the mapping: a change to `targetsFor` can no longer pass in
`score` and fail in `convert`.

```
ROLE                            MADE  EXACT  NAME  GONE  DROP  NONE   HIT
srv handler .js                   87     57     0     0    30     0  100.0%
service.cds                       19     19     0     0     0     0  100.0%
library                            0      0     0     0     0     1      —%
TOTAL                           1656   1610                       1   99.9%
```

`service.cds` reads 19 rather than 21 now, which is the truth: two folders hold
two `.xsodata` each and produce one merged file (§21). The old number counted
the prediction twice.

---

## 25. Two checks moved into the repo, and what the second one found

Everything §20, §22 and §24 measured was measured with a throwaway script in a
session scratch directory. Those directories do not survive the session, and §24
had already been reduced to writing *"the shapes are in the session scratch,
reproducible in ten lines"* — which is a note saying the evidence is gone.

Two of them are now `checks/`, because they are the two that change decisions:

| | What it answers |
|---|---|
| `checks/ceiling.js` | **What is this refusal worth?** Its site count is not the answer — a statement converts only when every blocker on it is gone, so the ceiling is the chains where it is the only one. `--code X` lists them with their SQL, which is the part that gets read |
| `checks/emitted.js` | Over a real emitted tree: every variable the emitter introduces is declared once and read in scope, no internal sentinel escapes, every `.js` parses as a module |

`ceiling.js` is the measurement that has now redirected the plan three times.
`emitted.js` found a bug on its first run in the repo.

### The bug: one NEO typo took out a whole service.js

```
srv/lib/TECK/…/JB_ALDRFTPOST/Services/service.js
  Identifier 'ErrorHandling' has already been declared
```

```js
import { CreateRecordlock, ErrorHandling,
         ErrorHandling::ErrorHandling as ErrorHandling__ErrorHandling } from '…/CommonUtil.js';
```

The `.xsodata` says:

```
create using "TECK.JOB_BIDDING.COMMON_View.Library:CommonUtil.xsjslib::ErrorHandling::ErrorHandling";
```

A typo — the grammar is `package:file::function`, and this has two `::`. The
imported name is emitted verbatim, so `ErrorHandling::ErrorHandling` went
straight into the import list and **the entire file stopped parsing**: every
handler in that service, lost, silently.

Two fixes, and the second is the real one:

1. `generateServiceJs` now requires the function name to be a JS identifier.
   Taking the last segment would be a guess about which half the author meant,
   so it refuses and names the alias it left unwired — rule 4.
2. **`convert` re-parses the `service.js` it generates.** Handlers have had that
   check since the JDBC tier, inside `transformFile`. `service.js` is *authored*
   rather than rewritten, so it went through no such gate and nothing would ever
   have told us. `SERVICE_JS_NOT_PARSEABLE` is a blocker.

That is the same lesson as §23 pointing inward: the output of a generator is not
verified by the generator's tests. Read it back with the parser that will have
to read it for real.

**All 270 emitted `.js` files across both corpora now parse.**

---

## 26. The last big bucket, measured twice — DONE

The plan said: run `checks/ceiling.js --code SQL_DYNAMIC`, **read ten of them
before writing anything**. Doing that, and then classifying all 96 by where the
run-time value sat, gave this — the same question §20 asked, asked of what §20
left behind:

| Shape | Chains | What it becomes |
|---|---:|---|
| the hole is a whole string literal — `WHERE N = '<hole>'` | 40 | `?` and a bind |
| DDL — `CREATE USER <hole> WITH IDENTITY '<hole>'` | 13 | interpolated, both holes: DDL takes no bind parameters at all |
| a joined list — `IN ('<a.join("','")>')` | 24 | interpolated exactly as NEO wrote it: one `?` cannot stand for a list |
| an IN-list built up in a loop | 11 | still refused |
| genuinely assembled at run time | 8 | still refused |

**77 of 96, deterministic, no model.** That is the fourth time the measurement
has said "smaller than you think", and the third time the answer to a bucket of
refusals turned out to be a rule of about forty lines.

`planHoles` in `db.js` decides hole by hole and returns null — refuse — if any
one hole has no answer. The two judgements it encodes:

- **A value hole converts only if it spans the whole literal.** `LIKE '%<hole>%'`
  does not: binding it would need the pattern rebuilt around the bind, and the
  quotes are not ours to move.
- **`.join(…)` means a list, not a value.** The expression brings its own quotes
  and commas; a `?` would compare the column against the whole joined string.
  Interpolating it is what NEO did and is exactly faithful, so it converts with
  a `SQL_VALUE_INTERPOLATED` note rather than refusing.

The bind order is arithmetic, not a guess: a lifted value takes a `?` position
of its own, so the *n*-th `setString` no longer fills the *n*-th `?` in the
statement. Both orders are known from the text, so the setters are renumbered
around the holes. `BIND_COUNT_MISMATCH` then holds as the check it always was.

### Then the same question of `READ_OUTSIDE_ROW`, which was now the biggest

47 chains, and **every single one is the same three lines**:

```js
} catch (e) {
    libCommon.createDBErrorLog('ClaimPortal', 'createUpdateEmpInfo',
                               rs.getNString(1), e.toString(), param);
}
```

Not a read after a loop at all — a read in a `catch`, logging the row the
handler was working on. Measured, not assumed: of 47 chains, 47 have exactly one
read outside the row scope and it is inside a `CatchClause` in all 47.

In NEO that read throws a *second* error inside the catch as often as not, since
the cursor is rarely on a row after a failure — so the error log never gets
written and the wrong exception propagates. In CAP the rows are an array that is
still there. `rs?.[0]?.PAYLOAD` says what the code meant and cannot throw.

So: a read outside the row scope **that is in a catch** converts, with a
`READ_IN_CATCH` note naming what it now reads. A read outside the loop that is
*not* in a catch is still a real restructuring and still refuses — there are 2,
and they block nothing on their own.

### What the two together did

| | before | after |
|---|---:|---:|
| statements converted, both corpora | 1615 / 1796 | **1738 / 1796 (96.8%)** |
| Corpus A | 611 / 673 (90.8%) | **658 / 673 (97.8%)** |
| Corpus B | 1004 / 1123 (89.4%) | **1080 / 1123 (96.2%)** |
| refused | 181 | **58** |

`cds build --production` still passes on both trees with 0 errors, all 270
emitted `.js` still parse, and `score` still reads 99.9%.

### And so: what is the AI tier worth now?

This is the fourth measurement, and the honest answer has moved a long way:

| Refusal | Ceiling | An AI task? |
|---|---:|---|
| `SQL_DYNAMIC` | 20 | 11 are an IN-list built up in a loop; 8 are genuinely assembled at run time; 1 is SQL arriving in a request body |
| `BIND_COUNT_MISMATCH` | 6 | No — procedures in a foreign schema we do not have |
| `NO_EXEC` | 6 | No — dead code. The right output is the report |
| `CURSOR_STEPPED` | 4 | Restructuring |
| `DEFERRED_RESULT_SET` | 2 | Restructuring, two statements |
| `BIND_CONDITIONAL`, `BIND_BATCHED`, `COLUMN_OUT_OF_RANGE` | 1 each | One statement each |

**58 statements, 3.2% of the corpus, and no bucket over 20.** Every one either
needs a judgement about code we cannot see, or is a NEO defect where the honest
output is the finding. A model asked to do these would be guessing in exactly
the place rule 4 exists to prevent. That is a decision for the user, not for the
tool — recorded here as a measurement, not as a refusal to build it.

## 27. `checks/verify.js` — the sweep as one command

§23's compile check found five defects the first time anyone ran it, by hand,
once. A check only ever run by hand stops being run, so it is now a command:

```bash
npm run verify -- <neo-dir> [<neo-dir> …] \
  --expect <hand-migrated-cf-dir> \
  --cds <cf-project>/node_modules/.bin/cds
```

tests → convert each corpus → `checks/emitted.js` → `checks/ceiling.js` →
`score` → **`cds build --production` on every emitted tree**, one PASS/FAIL line
each, non-zero exit if anything fails. `--no-build` skips the last step when
`@sap/cds-dk` is not installed; `--cds` points at any copy of it, which is how
this runs with nothing installed at all.

---

## 28. Tier 2 — the model answers a question, it never writes the code

Built, wired end to end, and run against both corpora with a real model. The
whole of it is `src/ai/` (three files, 290 lines) plus `--ai` on the CLI.

```bash
node bin/neo2cf.js dbscan  <neo> --ai claude
node bin/neo2cf.js convert <neo> -o out --write --ai claude
node bin/neo2cf.js convert <neo> -o out --write --ai "cmd:ollama run qwen2.5-coder:7b"
```

`--ai` defaults to `none`. **Tier 1 is identical in both modes**, which is what
D2 asks for, and is enforced by construction rather than by care: Tier 2 does
not have an emitter.

### The shape, and why it is safe with a 7B model

```
analyse  →  ask about what was refused  →  ANALYSE AGAIN  →  emit
```

The second analysis is the design. A model answer is fed back in as an *input to
Tier 1*, and Tier 1 then decides — so a model cannot bypass one existing check.
Bind counts, column names, OUT parameters, the cursor shape and the row-scope
rule all still have to pass. When the statement still does not resolve, the
answer is discarded and **the developer sees the original refusal, in its
original wording**. The worst a wrong answer can do is waste a call.

There is one task, and it exists because §26 measured what was left:

| | |
|---|---|
| task | `hole-classify` |
| asked | one word per interpolated value: `value` / `list` / `identifier` / `unknown` |
| never asked | anything quote parity can settle on its own (§20) — Tier 1 decides those before a prompt is built |
| never asked | a statement with a second blocker (§22's ceiling rule) — the answer would convert nothing |
| validated | a hole after `FROM`/`JOIN`/`INTO` cannot be a bind parameter and a hole after `=`/`LIKE`/`VALUES(` cannot be an identifier — **the SQL grammar overrules the model** |
| retried | once, with the rejection reason attached. Twice is Tier 3, which is where the statement already was |

`unknown` is a first-class answer and is recorded as one: "the model declined"
and "the model was never asked" are different facts, and only one of them is
worth asking again.

### What it is worth, measured

| | statements |
|---|---:|
| asked about (both corpora) | 16 |
| answered, checked, converted | **16** |
| declined | 0 |

Corpus A 655 → 656, Corpus B 1073 → 1088. Fifteen of the sixteen are the shape §26
predicted: `NOT IN (<a list built up in a loop>)`, which the model classified
`list` — so it is interpolated exactly as NEO wrote it, which is faithful and
converts the statement. One is `FROM <expression>` classified `identifier`, and
one is a year classified `value`, which became `WHERE YEAR(CRTDT)=?` with a bind.

**Every AI-settled statement says so in the file**, not only in the report:

```js
// AI-CLASSIFIED — a model decided how the value(s) spliced into this SQL
//   are treated (a value to bind, a list, or an identifier). Everything
//   else here is deterministic. Check it against the NEO original.
```

The CLI report is not there when someone reads the code six months later, and
"a model decided this" is the single most important thing for that reader to
know. 15 such comments across 7 files on Corpus B, 1 on Corpus A.

### The part nobody predicted: pointing a model at the refusals found bugs in Tier 1

The first real `--ai` run converted a statement Tier 1 had always refused —
and the *converted output* was visibly wrong. Three defects, all pre-existing,
all invisible while the statements they sat in were being refused for another
reason:

1. **`rsRow.null`.** `rs.getString(i)` with a computed index has no column name.
   `r.column` was null, no gap was raised, and the emitter wrote `rsRow.null` —
   which parses, which is why nothing caught it. **48 such reads had shipped in
   both emitted trees.** Now `COLUMN_INDEX_DYNAMIC`.
2. **`rs.getMetaData()` survived the rewrite.** The result-set call list was a
   blacklist by omission: anything that was not a getter or `next` was ignored,
   so a JDBC method CAP does not have came through into a "converted" file that
   would throw on the first row. Now a whitelist — an unrecognised method is a
   refusal (`RESULTSET_METHOD_UNSUPPORTED`).
3. **`query += ' GROUP BY …'` read as the whole statement.** The worst of the
   three by far. `resolveSql` took the last assignment to a variable and used its
   right-hand side — correct for `=`, catastrophic for `+=`, where the
   right-hand side is a *fragment*. It emitted:

   ```js
   rs = await cds.run(`GROUP BY CS.CMGID,CM.EMPNM`);
   ```

   A confident, silently wrong conversion — the one outcome this tool exists to
   avoid. A compound assignment now means the SQL is assembled at run time,
   which is what `SQL_DYNAMIC` has always meant.

Fixing all three costs 8 statements that were "converting" (1738 → 1728 for the
deterministic tier). That is the trade the tool exists to make, and the numbers
in §26 should be read as having been slightly wrong rather than these as a
regression.

**The lesson is not about AI.** Every one of these was found by *emitting code
for statements that had never been emitted before*. A refusal hides whatever is
downstream of it. Any change that converts a new class of statement should be
followed by reading the output of the statements it just unblocked.

## 29. The missing `await`, 1,266 of them — DONE

`transform/file.js` derives async over one file's call graph and then says,
honestly, where it stops:

> made async: createUpdateEmpInfo, deleteNotes — **callers in other files must
> await these**

`checks/awaits.js` was written to find out whether anyone could act on that. It
reads the whole emitted tree, resolves each relative import to the file it names,
and checks every call to a function that file declares `async`:

```
270 emitted .js · 1594 cross-file call(s) to an async function
1266 MISSING AWAIT(S)
```

**This was the largest defect class in the output by an order of magnitude** —
twenty times the 68 statements the JDBC tier refuses — and the worst kind: a
Promise used as a value does not throw. `if (rows.length)` on a Promise is
`undefined`, so the code runs, takes the wrong branch, and writes the wrong
data. Not the parser, not `cds build`, not a smoke test sees it.
CONVERSION-STRATEGY.md §3 already recorded it as the mistake the *hand*
migration made most often.

`src/emit/awaits.js` finishes the propagation in `convert`, which is the only
place that has every file at once. It reads the JavaScript the tool has already
emitted, builds one call graph across the tree, and runs a fixed point:

> a call to an async function needs `await` → the function containing that call
> is async → so do its callers, in this file and every other

Then it splices the edits in and **re-parses every file it touched**; a file the
pass would have broken is left exactly as it was and reported as a blocker.

| | Corpus A | Corpus B |
|---|---:|---:|
| cross-file `await`s added | 543 | 732 |
| functions made async | 0 | 2 |

`checks/awaits.js` now reports **every one of the 1,594 calls is awaited**, both
trees still pass `cds build --production`, all 270 files still parse, and `score`
still reads 99.9%.

What it deliberately does not do, each counted rather than guessed: a call
through a variable it cannot name, an import that does not resolve to a file we
emitted, and a call at module top level — where an `await` would need top-level
await and change when the module finishes loading. `.then()` chains are left
alone; that Promise is being held on purpose.
