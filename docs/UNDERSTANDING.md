# NEO → CF Code Migrator — Understanding

Working notes. Written for whoever (or whatever) picks this up next, including a
future session of me. Everything here is either **verified on disk** or
explicitly marked as an assumption. Where the existing knowledge bases and the
actual codebases disagree, the codebase wins and the disagreement is recorded.

Date of survey: 2026-09-05. Scope confirmed by the user the same day (§0).

---

## 0. Scope decisions — confirmed, and they override anything below

1. **Independent conversion. Not cleanup.** The tool does the structural
   conversion itself. It does not consume SAP migration assistant output.
2. **Two modes, both first-class:**
   - **without AI** — deterministic transforms only, best effort;
   - **with AI** — a pluggable model backend. Target is the on-premise local
     model; for now the backend is **Claude Code driven headlessly**, mimicking
     API usage.
   The goal is *the highest achievable conversion rate in **both** modes.*
   Most runs will use AI, but the no-AI path must stand on its own.
3. **Corpus B was migrated with SAP's assistant + Claude Code cleanup**, not from
   scratch. So `ICBC-cf-code` shows *what the assistant emits*, not what this
   tool should emit. This resolves the 584 `.hdbview` mystery (§3) — they are
   assistant artifacts. **Corpus A is the reference for output shape; Corpus B is a
   second data point on NEO input shape only.**
4. **Out of scope entirely — not used in the CF app:**
   `.xsjob` · `.xshttpdest` · `.analyticprivilege` · `.xsaccess` · `.xsprivileges`
   (~104 files in Corpus A). This closes KB open questions #17–#20.
5. **`.hdbtable` is out of scope.** Tables matter in CF but are generated
   manually by separate scripts from the live DB. The tool does not emit them.
6. **⚠ The tool migrates what is in NEO. Nothing else.** The validation layer,
   `Middleware/`, and the other CF-only files found in §5 were **added later by
   the developer**. They are *not* the tool's concern and the tool must **not**
   scaffold them. §5 stays in this document as useful context for reading the CF
   reference code — not as a requirement. My earlier recommendation to scaffold
   them was wrong and has been removed from §7.

---

## 1. What is actually being asked for

> Give the tool a **SAP NEO codebase**. Get back a **SAP CF (CAP/Node.js)
> codebase**, mirroring the NEO folder structure, converting whatever can be
> converted, at best effort.

Three things the user said that constrain the design more than anything else:

1. **"following same folder structure as what neo was following"** — the output
   is not a greenfield CAP app. It mirrors NEO's own tree, transformed by a
   known, literal folder mapping (§4).
2. **"at least converting at what possible at its best efforts"** — partial
   output is a success, not a failure. The tool is allowed to emit a file with a
   `NEEDS HUMAN REVIEW` marker. It is *not* allowed to silently invent logic.
3. **"any how we need to manually test each and every api"** — the tool is
   explicitly **not** trusted to be correct. Every API gets hand-tested
   afterwards regardless. So the objective function is **developer hours saved**,
   not correctness percentage.

That third point is the single most important design input, and it inverts the
usual trade-off. A tool that converts 70% mechanically and flags the other 30%
loudly is *better* than one that converts 95% and hides where it guessed —
because the human is re-testing everything either way, and a wrong-but-confident
output costs more to find than an honest gap.

**The deliverable is a codebase transformer, not an assistant and not a chat
loop.** Input: a folder. Output: a folder, plus a report saying what it could not
do.

---

## 2. Prior work — two different strategies, both already explored

The user has attempted this twice, with **opposite** strategies. Both knowledge
bases exist on disk and both are useful, but they are not compatible workflows
and it matters which one the tool implements.

### A. `C:\Sodales\Projects\migration-kb` — build from scratch, *replace* SAP's tool

20 files. `MIGRATION_WORKFLOW.md` states it plainly:

> "This is the execution procedure a Claude Code instance follows to migrate one
> NEO module to CAP/CF **from scratch, without SAP's HANA Application Migration
> Assistant.** We are *replacing* that tool, not assisting it. Its bulk
> mechanical conversion is exactly the part that is unreliable; our value is
> **reasoning over the actual logic**."

Contents worth knowing:
- `CLAUDE.md` — the verified literal folder mapping + placeholder vocabulary.
- `rules/checklist-final.md` — **the single most important artifact.** 24 items,
  classified 🟢 automatic / 🔴 manual / 🟡 needs-verification.
- `rules/naming-conventions.md` — flattening rule, and the numeric-leading rule.
- `rules/proxy-entity-patterns.md` — per NEO artifact type, what it becomes.
- `rules/service-layer-patterns.md` — `service.cds`/`service.js`, and the 7c-vs-14 boundary.
- `templates/` — parametrised code for the four cross-cutting mechanisms.
- `OPEN_QUESTIONS.md` — 22 numbered unknowns. Read before trusting any rule.

Its golden rule is worth carrying into the tool verbatim:

> "Both the NEO source and the CF result are present. **Always diff them
> directly.** Never infer the NEO source from the migrated output, and never
> invent a rule that isn't demonstrated by at least one real file."

### B. `C:\Sodales\Projects\cleanup-tool\cleanup-kb` — clean up SAP's tool's output

9 files. The opposite premise: let SAP's **HANA Application Migration Assistant**
run first and do the bulk structural conversion, then apply a deterministic
25-item cleanup checklist to its output, section by section.

- Unit of work is a **"section"** (a role-based folder, e.g. `HR_role`), one per run.
- Hard constraint, quoted: *"If fixing something requires understanding what the
  business logic is DOING — rather than applying a known pattern from the
  checklist — that is a **red flag**. Do not guess."*
- Item 25 (`SESSION_USER` → `SESSION_CONTEXT('APPLICATIONUSER')`) is the one item
  this KB has that `migration-kb`'s 24-item list does not.
- Targets Corpus B's three modules: JBD, DSM, TLW.

**Critical caveat, stated in that KB itself:**

> "No real raw assistant output has been seen yet. Everything in
> `INTAKE_AND_PLACEMENT.md` about the *shape* of raw output is a stated
> **assumption**."

So workflow B has never been run against real assistant output. Its checklist is
sound (it was derived from the same completed migration), but its intake model is
unvalidated guesswork.

### Which one should the tool be?

**Confirmed: A — independent conversion (§0.1).** The reasoning below is kept
because it explains *why*, and because B's checklist is still reused as the
tool's validation pass.

B depends on SAP's assistant, which:
- runs inside SAP Business Application Studio, not on a developer's machine,
- cannot be scripted into a `folder in → folder out` tool,
- and per `checklist-final.md`'s own conclusion: *"no checklist item was left in
  the assistant's raw output — every one required either a manual edit or
  verification."*

A tool that requires the user to first run a GUI wizard in BAS is not the
deliverable the user described. **The tool should do the structural conversion
itself** (which is the part that is mechanical and reliable) and reuse B's
checklist as its *validation* pass.

This needs confirming with the user before building — see §9.

---

## 3. Ground truth — the four reference codebases

Two complete NEO→CF migrations, done by hand. This is the training data and the
test set.

### Artifact inventories (verified counts, 2026-09-05)

| NEO artifact | TECK-neo-code | ICBC-neo-code |
|---|---:|---:|
| `.calculationview` | 454 | 587 |
| `.hdbprocedure` | 169 | 203 |
| `.xsjs` | 60 | 50 |
| `.xsjslib` | 28 | 71 |
| `.xsodata` | 21 | 48 |
| `.xsaccess` | 21 | 42 |
| `.xsprivileges` | 20 | 42 |
| `.analyticprivilege` | 20 | 29 |
| `.xsjob` | 34 | 22 |
| `.xshttpdest` | 9 | 15 |
| `.hdbtable` | 6 | 0 |
| `.hdbtablefunction` | 0 | 1 |
| `.hdbview` | 0 | 0 |
| **total files** | **848** | **1117** |

| CF artifact | teck-jbd-backend | ICBC-cf-code (3 projects) |
|---|---:|---:|
| `db/cds/**/*.cds` | 454 | 491 |
| `.hdbcalculationview` | 454 | 988 |
| `.hdbfunction` | 454 | 994 |
| `.hdbprocedure` | 157 | 420 |
| `.hdbtable` | 58 | 721 |
| `.hdbview` | 0 | 584 |
| `service.cds` / `service.js` | 19 / 19 | 43 / 86 |
| `.js` (total) | 107 | 409 |

### What those numbers prove

**The calc-view pipeline is exactly 1:1:1:1 and fully mechanical.**
454 `.calculationview` → 454 `.hdbcalculationview` + 454 `TABLE_FUNCTION_*.hdbfunction`
+ 454 `db/cds/*.cds`. Not approximately — exactly. This is ~53% of all NEO files
in Corpus A and it is the single biggest, safest win available to the tool.

**Procedures shrink** (169 → 157, 203 → 420 across 3 duplicated projects). Some
NEO procedures are dropped. Which ones and why is not documented anywhere —
needs investigating before the tool decides what to do with them.

**Tables do not come from NEO.** Corpus A has 6 `.hdbtable` in NEO but 58 in CF;
Corpus B has **zero** in NEO and 721 in CF. Table DDL is produced by a separate
"Dynamic Table Creation" tool from the live HANA catalog, not migrated from
source. **The tool should not try to generate `.hdbtable` files** — it should
detect the gap and say so.

**`.xsodata` → service pairs is not 1:1.** Corpus A: 21 `.xsodata` → 19
`service.cds`. Corpus B: 48 → 43 `service.cds` but **86** `service.js`. Services get
split, merged, or dropped. Not mechanical.

### Discrepancies against the knowledge bases (found by this survey)

1. **584 `.hdbview` in ICBC-cf-code, zero in ICBC-neo-code — resolved (§0.3):**
   Corpus B was migrated with SAP's assistant and cleaned up afterwards, so those are
   **assistant-generated artifacts**. This also settles `migration-kb`'s open
   question #4, which had recorded `.hdbview` as "not demonstrated". It means
   **ICBC-cf-code is not a model for this tool's output** — it is a model of what
   SAP's assistant emits. Use Corpus A for output shape.
2. **Corpus B has 3 modules on disk** (`ICBC-JBD-CF`, `ICBC-DSM-CF`, `ICBC-TLW-CF`),
   matching `cleanup-kb`'s JBD/DSM/TLW scope. Moot for output shape now, but
   relevant if Corpus B's NEO source is used as a test input.
3. **`JB_DATAMIGRATION` exists in NEO and not in CF.** 13 NEO modules → 12 CF
   modules. Presumably a one-off data-migration module deliberately not carried
   over. The tool needs a concept of "modules to skip".

---

## 4. The transformation, as verified

### Folder mapping (from `migration-kb/CLAUDE.md`, confirmed against disk)

```
NEO                                                   CF
───                                                   ──
<APP>/<MOD>/<SUB>/Views/*.calculationview     →  db/src/<MOD>/<SUB>/Views/*.hdbcalculationview
                                              →  db/src/<MOD>/<SUB>/Views/TABLE_FUNCTION_*.hdbfunction
                                              →  db/cds/<MOD>/<SUB>/Views/<FLAT_UPPER>.cds
<APP>/<MOD>/<SUB>/Procedures/*.hdbprocedure   →  db/src/<MOD>/<SUB>/Procedures/*.hdbprocedure   (no cds proxy)
<APP>/<MOD>/<SUB>/Library/*.xsjslib           →  srv/lib/<SCHEMA>/<APP>/<MOD>/<SUB>/Library/handlers/*.js
<APP>/<MOD>/<SUB>/Services/*.xsjs             →  srv/lib/<SCHEMA>/<APP>/<MOD>/<SUB>/Services/handlers/*.js
<APP>/<MOD>/<SUB>/Services/*.xsodata          →  srv/lib/<SCHEMA>/<APP>/<MOD>/<SUB>/Services/service.cds + service.js
```

Two asymmetries that are easy to get wrong:
- **`db/cds/` drops the `<APP>` wrapper.** `srv/lib/<SCHEMA>/<APP>/…` keeps it.
- The CF bucket name **equals the real NEO top-level folder name** — never
  relabel into `Env_Config`/`Inbound`/`Outbound` (this is `cleanup-kb`'s warning,
  and it contradicts a naive reading of `migration-kb`; the KB's own note about
  `xsjob_Notification` → `Outbound` is the exception, not the rule).

### Naming — the flattening rule

```
NEO:  TECK.JOB_BIDDING.JB_ADMIN_CONSOLE.Views::TECK_M_getSUPList
CF:   entity TECK_JOB_BIDDING_JB_ADMIN_CONSOLE_VIEWS_TECK_M_GETSUPLIST
```
1. Every `.` and every `::` → `_`
2. UPPERCASE the whole string
3. File is `<ENTITY_NAME>.cds`; the entity inside has the same name

**Do not trust this to be predictable.** `OPEN_QUESTIONS.md` #1 records that the
same view (`TECK_JB_Clob`) came out as the short `VIEWS_TECK_JB_CLOB` in one
module and the full `TECK_JOB_BIDDING_JB_ADMIN_CONSOLE_VIEWS_TECK_JB_CLOB` in
another. Whether that is a rule, an older assistant run, or a hand-edit is
**unknown**.

### The numeric-leading identifier rule ⚠

CDS/HDI reject identifiers starting with a digit. NEO's Web-IDE OData aliases are
random tokens and some start with digits. Real renames from Corpus A:

| NEO alias | CF name | Where |
|---|---|---|
| `91Efu5zcsYvGmdP` | `yuEfu5zcsYvGmdP` | entity |
| `9UPBK9QDitgIuOp` | `IUPBK9QDitgIuOp` | action (COMMON) |
| `9UPBK9QDitgIuOp` | `oUPBK9QDitgIuOp` | action (JB_HR) |

The **same NEO alias got different CF names in different modules**, chosen by
hand. These aliases are what the UI calls, so every rename must be published to
the UI team. The tool should use a **deterministic** scheme and emit the
before/after table — determinism is for the tool, the table is for the humans.

### The 24/25-item checklist — what it really says

Full text: `migration-kb/rules/checklist-final.md`. The conclusion is the
important part:

> "Cross-checking the finished project, **no** checklist item was left in the
> assistant's raw output — every one required either a manual edit or
> verification. The assistant's *value* is the bulk file generation, not
> correctness of these 24 details."

Grouped by what a tool can actually do:

**Purely mechanical — a tool can do these 100%** (regex/AST, no judgement):
- 3 — `dataCategory="DEFAULT"`→`"DIMENSION"`, `applyPrivilegeType`→`"NONE"`
- 8/12/23 — strip `"<SCHEMA>".` qualifiers and over-prefixed table names
- 13 — procedure call paths: `.`→`_`, `::`→`_`, drop quotes
- 21 — `UTCTOLOCAL(CURRENT_TIMESTAMP,'CST','sap')` → `UTCTOLOCAL(...,'America/Chicago')`
- 22 — quote sequence names
- 24 — `A = B` → `LOWER(A) = LOWER(B)`
- 25 — `SESSION_USER` → `SESSION_CONTEXT('APPLICATIONUSER')`
- 7a — `require()` → `import`
- 7b — `srv.on('CREATE','X',fn)` → `srv.on('X',fn)`
- 9 — delete stray `*.properties` / `Proxy_Hdbfunction.cds`

**Mechanical with a lookup the tool must build:**
- naming/flattening, numeric-leading renames
- 5 — every `.cds` entity needs a `key` (needs the real PK, from HANA or the view)

**Needs reasoning — flag, do not guess:**
- 7c / 14 — the request-vs-helper boundary (see below)
- 16 — procedure result object vs array (depends on whether the proc returns OUT
  params or a result set)
- 4, 6 — import paths and association targets resolving
- 17, 18, 19 — await auditing, `cds.tx` isolation for logging, `JSON.stringify` returns

### The 7c-vs-14 boundary (the rule most likely to be got wrong)

The two checklist items look contradictory. They apply to different layers:

```
service.js   srv.on(alias, req => handlerFn(req))     ← 14: pass req DIRECTLY
   ↓
Library/handlers/*.js  async function handlerFn(req) {
     const payload = req.data.PAYLOAD;                 ← 14: extract from the REQUEST
     ...                                               ←     never re-query a table for it
     await getEmailTemplates(1, emailFields);          ← 7c: helpers get PRIMITIVES only
```

The test is **distance from the request**, not the function's folder. Entry
functions take `req`; everything they fan out to takes values.

---

## 5. What graphify added that the knowledge bases did not have

Graphify was installed and run for this survey. Honest assessment of its value
here, good and bad.

### It is blind to NEO

`graphify detect` on `TECK-neo-code` found **5 of 848 files** — the 4 `.txt` and
1 `.md`. It does not recognise `.xsjs`, `.xsjslib`, `.calculationview`,
`.hdbprocedure`, `.xsodata`, or any other SAP extension. **The entire NEO
artifact set is invisible to it.**

If graphing NEO is wanted, it needs an extension shim (a shadow tree with
`.xsjs`→`.js`, `.hdbprocedure`→`.sql`, `.calculationview`→`.xml`). That is cheap
to build and would be genuinely useful — but it does not exist yet, and nothing
below depends on it.

### On the CF side it earned its keep

`srv/` of `neo-to-cf-teck-jbd-backend`: 91 code files → **489 nodes, 1542 edges,
21 communities**, pure AST, no LLM, no API key, no subagents.

God nodes (most connected):

| Function | Edges |
|---|---:|
| `aesDecode()` | 130 |
| `validateInt()` | 102 |
| `validateText()` | 81 |
| `isValidationError()` | 65 |
| `validateDropdown()` | 35 |
| `validateOneOf()` | 27 |
| `SendEmail()` | 22 |
| `rateLimiter()` | 21 |
| `ErrorHandling()` | 18 |
| `resyncAllRolesToIAS()` | 14 |

**The finding: five of the top six god nodes are a validation layer that neither
knowledge base documents at all.**

Verified: `srv/lib/TECK/JOB_BIDDING/COMMON_View/Library/handlers/ValidationUtil.js`
is used by **20 files**, and grepping `TECK-neo-code` for `validateInt`,
`validateText`, `isValidationError` returns **zero hits**. It has no NEO ancestor.
It was **written by hand during the migration**, not translated.

### The CF-only files — what humans added

Comparing every CF handler filename against NEO `.xsjs`/`.xsjslib` names:

```
AssignDynamicRoles    BootstrapGroups     custom-service
datapull-service      hanaIdentifier      rateLimitChecker
ResyncIASUserRoles    RoleAssignment      roleCheckAccess
service               sweepGuard          ValidationUtil
```

Four of those (`RoleAssignment`, `BootstrapGroups`, `AssignDynamicRoles`,
`ResyncIASUserRoles`) are the dynamic-role-assignment mechanism that
`migration-kb/templates/` covers. **The other eight are undocumented.**

Also CF-only: the top-level `srv/lib/TECK/Middleware/` and `srv/lib/TECK/Outbound/`
folders. NEO has `Env_Config`, `Inbound`, `xsjob_Notification`.

### What this means — corrected

My first reading was that the tool should scaffold these. **That was wrong**, and
the user corrected it (§0.6): these were added by the developer *after* the
migration. Adding a validation layer, middleware or a rate limiter is a CF
engineering decision, not a translation of anything in NEO.

**The tool migrates what is in NEO. Nothing else.** No scaffolding, no
"projects usually add X", no gap report about missing validation.

The finding is still worth keeping, for two reasons:
1. When diffing Corpus A's CF output against its NEO source to derive or check a
   rule, these files are **noise** — they have no NEO ancestor. Anyone (or any
   future session) doing that diff needs to know which files to ignore, or they
   will invent rules from code that was never migrated.
2. It sets the ceiling honestly. A perfect run of this tool still does not
   produce the finished CF app, and nobody should be surprised by that.

### Operational notes for running graphify here

- `uv` is installed but winget put it on PATH only for **new** shells. Interpreter
  that actually has graphify:
  `C:\Users\SLS1402\AppData\Roaming\uv\tools\graphifyy\Scripts\python.exe`
  (note: `%APPDATA%`, not `%LOCALAPPDATA%`).
- Heredoc-into-stdin triggers a Windows `multiprocessing` spawn failure
  (`OSError: [Errno 22] ... '<stdin>'`). It falls back to sequential and still
  works, but **use a script file** (`graphs/build.py`) to avoid the noise, or pass
  `parallel=False`.
- ⚠ **`extract(cache_root=...)` writes a `graphify-out/cache/` directory into the
  scanned tree.** It wrote into `TECK-neo-code/` and
  `neo-to-cf-teck-jbd-backend/srv/`, both of which `migration-kb` forbids
  modifying. Removed after this survey; verified gone. **Watch for this** — point
  `cache_root` at a scratch dir instead.
- The graphs built for this survey have been **deleted**. They were scaffolding
  for reading the corpora, everything they showed is written down above, and
  they held customer file names and SQL inside the tool repo. `graphs/build.py`
  is kept — it is the recipe if a corpus ever needs graphing again. The graph
  that *is* maintained is `graphify-out/`, and it maps this tool, not a corpus.

---

## 6. Feasibility — what fraction is actually mechanical

Sized against Corpus A's 848 NEO files, after the §0 scope cuts.

### In scope — 732 files

| Layer | Files | No-AI mode | With-AI mode |
|---|---:|---|---|
| Calc views → `.hdbcalculationview` + `TABLE_FUNCTION_*` + `.cds` proxy | 454 | **Full** — 1:1:1:1 verified | same (no AI needed) |
| Procedures → cleaned `.hdbprocedure` | 169 | **Full** — copy + 7 regex fixes, never rewrite logic | same (no AI needed) |
| `.xsodata` → `service.cds` | 21 | **Full** — it is a parseable grammar | same |
| `.xsodata` → `service.js` | 21 | **Skeleton** — correct `srv.on` aliases, empty bodies | **Full** — bodies wired to handlers |
| `.xsjslib` / `.xsjs` → handler `.js` | 88 | **Skeleton** — imports, signatures, SQL fixes, `NEEDS REVIEW` markers | **Body conversion** — the reasoning step |

**No-AI ceiling: ~644 of 732 files fully converted (~88%)**, plus usable
skeletons for the remaining 88. The deterministic band is not a fallback — it is
the bulk of the work, and it is the part that is tedious and error-prone by hand.

**With-AI**, the 88 `.xsjs`/`.xsjslib` files get real body conversion. That is
where the human hours actually go today, and it is ~12% of the file count but
most of the thinking.

### Out of scope — 116 files

`.xsjob` (34) · `.analyticprivilege` (20) · `.xsaccess` (21) · `.xsprivileges` (20)
· `.xshttpdest` (9) · `.hdbtable` (6) · `.xsapp` (1) · docs (5)

Per §0.4 and §0.5. The tool should still **inventory** them so nothing vanishes
silently, and say plainly that it did not convert them.

---

## 7. What the tool should do

Framing. The build plan is `docs/PLAN.md`.

**Shape:** `neo-folder in → cf-folder out`, plus a report. Runs locally. Not a
chat loop, not a BAS plugin, not dependent on SAP's assistant.

**Passes, in the dependency order the KB insists on** (procedures → functions →
views → services; parents before children):

1. **Intake & inventory** — count every artifact type, extract
   `<SCHEMA>`/`<APP>`/`<MODULE>`/`<SUBMODULE>` from the paths, scan for
   numeric-leading identifiers and cross-module dependencies. Emit before
   converting anything. Out-of-scope types are listed, not converted.
2. **Deterministic transforms** — the calc-view 1:1:1:1 pipeline, procedure
   copy-and-clean, the mechanical checklist fixes. Runs in **both** modes and
   accounts for ~88% of in-scope files.
3. **Structural transforms** — `.xsodata` → `service.cds` (full) + `service.js`
   with correct `srv.on` aliases.
4. **Body conversion** — `.xsjs`/`.xsjslib` handler logic.
   *No-AI:* skeleton — imports, entry signature taking `req`, the SQL dialect
   fixes applied to any raw SQL found, and `// NEEDS HUMAN REVIEW` at every point
   requiring judgement.
   *With-AI:* the model converts the body, constrained by the KB rules, and the
   deterministic fixes are re-applied over its output.
5. **Validate** — run the checklist as assertions over the *output*, exactly the
   way `hana-data-mover` validates before writing. Every finding carries a fix.
   This runs identically in both modes, and it is what makes the AI mode
   trustworthy: the model's output is checked by the same deterministic rules,
   not taken on faith.
6. **Report** — inventory, what converted, what was skeletoned, every rename (for
   the UI team), every cross-module dependency, out-of-scope files, and the
   "needs human review" list.

**The AI backend is a pluggable adapter**, the same shape as `hana-data-mover`'s
`SourceAdapter`: one interface, several implementations (`none`, Claude Code
headless, on-prem OpenAI-compatible endpoint). Everything else in the pipeline is
identical between modes — only step 4 differs.

**The two rules to carry over verbatim from the KBs:**
- *Never invent a rule that isn't demonstrated by at least one real file.*
- *If fixing something requires understanding what the business logic is DOING,
  that is a red flag — flag it, don't guess.* (In AI mode this becomes: let the
  model try, then verify deterministically, and mark anything unverifiable.)

**Not the tool's job** (§0.6): validation utilities, middleware, rate limiting,
`.hdbtable` generation, or anything else the developer adds to the CF app
afterwards.

---

## 8. Risks

1. **Naming is not fully deterministic.** `OPEN_QUESTIONS.md` #1 — the same view
   flattened two different ways. If the tool guesses wrong, the `using` paths in
   `service.cds` break. Mitigation: emit both, or resolve against a real
   generated file, or make the tool's own scheme authoritative and regenerate the
   `using` statements to match.
2. **~104 files have no migration rule at all** (§6). Scoping these out loudly is
   better than a half-answer.
3. **The KBs describe Corpus A; Corpus B differs** — 584 `.hdbview` from nowhere, 3
   modules not 2, zero `.hdbtable` in NEO. A rule derived from one project and
   applied blindly to the other will break.
4. **`migration-kb/OPEN_QUESTIONS.md` #11 reports live HANA credentials and TLS
   certificates committed in `cf-code/db/.env`.** Not this tool's job, but if the
   tool ever copies a `db/` tree it must not carry that forward. Worth telling
   the user separately.
5. **Procedures shrink 169 → 157** with no documented reason. Until that is
   understood, the tool should carry all of them and flag the delta.

---

## 9. Open questions for the user

### Resolved (§0)

| # | Question | Answer |
|---|---|---|
| 1 | Convert independently, or clean up the assistant? | **Convert independently**, two modes (AI / no-AI) |
| 2 | Is `.hdbtable` in scope? | **No** — generated manually by separate scripts |
| 3 | Where do Corpus B's 584 `.hdbview` come from? | **SAP's assistant** — Corpus B was assistant + Claude Code cleanup |
| 4 | Scope of `.xsjob`/`.xshttpdest`/privileges/`.xsaccess`? | **Out entirely** — unused in the CF app |
| 5 | Two Corpus B modules or three? | Three on disk; moot now that Corpus B is not the output reference |
| 6 | Should CF-only files (validation, middleware) be scaffolded? | **No** — developer additions, not the tool's concern |

### Still open

1. **Numeric-leading renames.** Corpus A renamed by hand and inconsistently (the same
   alias → two different names in two modules). A deterministic scheme is
   strongly recommended; needs the team's sign-off because the OData names the UI
   calls will change. Whatever is chosen, the before/after table still ships.
2. **Naming is not fully deterministic** — `OPEN_QUESTIONS.md` #1, the same view
   flattened two ways. Since the tool generates both the proxy `.cds` and the
   `using` statements that reference it, it can make its own scheme
   self-consistent. That works as long as nothing *outside* the generated output
   refers to those entity names.
3. **Procedures shrink 169 → 157** in Corpus A with no documented reason. Carry all
   of them and flag the delta until someone explains it.
4. **AI backend contract** — how the tool talks to Claude Code headlessly, and
   what the same interface looks like against the on-prem model. Proposed in
   `docs/PLAN.md`; needs confirming against the real on-prem setup.

---

## 10. Paths

| What | Where |
|---|---|
| From-scratch KB | `C:\Sodales\Projects\migration-kb` |
| Cleanup KB | `C:\Sodales\Projects\cleanup-tool\cleanup-kb` |
| NEO source (Corpus A) | `C:\Sodales\Projects\TECK\TECK-neo-code` |
| CF result (Corpus A, 1 module) | `C:\Sodales\Projects\TECK\neo-to-cf-teck-jbd-backend` |
| NEO source (Corpus B) | `C:\Sodales\Projects\ICBC\Migration\ICBC-neo-code` |
| CF result (Corpus B, 3 projects) | `C:\Sodales\Projects\ICBC\Migration\ICBC-cf-code` |
| This tool | `C:\Sodales\Tools\neo-to-cf-migrator` |
| CF service-layer graph | `graphs/teck-cf/graphify-out/` |
| Sibling tool (data movement) | `C:\Sodales\Tools\hana-data-mover` |

**Never modify the four reference codebases.** Both KBs say so, and the graphify
cache incident (§5) shows how easily a tool does it by accident.
