# Conversion strategy — per artifact type

The question this answers: *"I don't think static js scripts or regex can do
anything here, mostly AI is the only option — so how does execution work?"*

**Short answer: AI is not the only option, and treating it as the only option is
the failure mode.** The evidence is below, measured on your own corpora. The
recommended model is three tiers, with AI doing the smallest job that only AI can
do — and never being handed a whole file with "convert this".

---

## 1. The complete artifact taxonomy

Every extension present in both NEO corpora, counted (not from documentation —
from disk). XS Classic defines more types than this; these are the ones you have.

| Extension | Corpus A | Corpus B | Class | Strategy |
|---|---:|---:|---|---|
| `.calculationview` | 454 | 587 | DB model | **Deterministic** — generate from embedded SQLScript |
| `.hdbprocedure` | 169 | 203 | DB code | **Deterministic** — copy + 7 SQL fixes, never rewrite |
| `.xsjs` | 60 | 50 | **JS service** | Three-tier (§4) |
| `.xsjslib` | 28 | 71 | **JS library** | Three-tier (§4) |
| `.xsodata` | 21 | 48 | Service model | **Deterministic** — measured, fully derivable |
| `.hdbtable` | 6 | 0 | DB table | Out of scope (§0.5) — generated from live DB |
| `.hdbtablefunction` | 0 | 1 | DB code | Deterministic (same as procedure) |
| `.xsaccess` | 21 | 42 | Config | **Out of scope** (§0.4) |
| `.xsprivileges` | 20 | 42 | Auth | **Out of scope** |
| `.analyticprivilege` | 20 | 29 | Auth | **Out of scope** |
| `.xsjob` | 34 | 22 | Scheduler | **Out of scope** |
| `.xshttpdest` | 9 | 15 | Destination | **Out of scope** |
| `.xsapp` | 1 | 1 | App marker | Out of scope |

**Only three types carry JavaScript: `.xsjs`, `.xsjslib`, and the `service.js`
half of `.xsodata`.** That is 88 files in Corpus A, 121 in Corpus B. Everything else is
XML, SQLScript, or config — all deterministic.

So the "AI problem" is ~12% of in-scope files. It is the hard 12%, but scoping it
correctly stops AI leaking into the other 88%, which is where the toolkit's
triage module is emphatic:

> "The tempting failure mode is to hand the model every unresolved finding and
> let it sort them out. That is worse than useless — it spends tokens on work a
> parser already does deterministically, and it **launders a mechanical
> transform into a probabilistic one**."

---

## 2. The XSJS API surface is a closed set

Every `$.` reference across both corpora, counted:

| Idiom | Count | Becomes | Deterministic? |
|---|---:|---|---|
| `$.import` + `$.<pkg>.<Lib>` alias | 358 + ~230 | ES `import` | **Yes** — pure name resolution |
| `$.response.setBody` | 321 | `return` value | **Yes** — shape rewrite |
| `$.response.status` | 278 | `req.error()` / return | **Yes** |
| `$.db.getConnection` | 214 | `cds.run(...)` | **Mostly** — see §3 |
| `$.response.contentType` | 149 | dropped (CAP sets it) | **Yes** |
| `$.request.method` + `$.net.http.*` | 98 + ~350 | dropped — CAP routes | **Yes** |
| `$.web.WebRequest` / `$.net.http.Client` / `readDestination` | 76 + 61 + 61 | `executeHttpRequest({destinationName})` | **Yes** — template exists |
| `$.util.codec.decodeBase64` / `encodeBase64` | 59 + 6 | `Buffer.from(x,'base64')` | **Yes** |
| `$.session.getUsername` | 57 | `SESSION_CONTEXT('APPLICATIONUSER')` | **Yes** |
| `$.request.body.asString` | 34 | `req.data.PAYLOAD` | **Yes** |
| `$.request.parameters` | 22 | `req.data.*` | **Yes** |
| `$.jobs.Job` | 13 | — | Out of scope |

**That is the whole surface. About 15 idioms, all with a known target form.**

This is the single most important fact in this document. XSJS is not an
open-ended language problem — it is a small, fixed, *enumerable* API, and a
transform that handles those 15 cases covers the overwhelming majority of every
`$.` occurrence in 209 files.

---

## 3. What the transformation actually looks like

Real matched pair, `TECK_HR_Notes` (NEO `.xsjslib` → shipped CF `.js`):

**NEO:**
```js
$.import("TECK.Env_Config", "CommonUtil");
var libEnvAth = $.TECK.Env_Config.CommonUtil;

function checkAccess(VIEWTYPE){
    var conn,query,pstmt,rs,User = '',cntt = 0;
    conn = $.db.getConnection();
    query1 = 'SELECT LOWER(SESSION_USER) FROM DUMMY ';
    pstmt1 = conn.prepareStatement(query1);
    rs1 = pstmt1.executeQuery();
    if(rs1.next()){ User = rs1.getNString(1) || ''; }
    if(VIEWTYPE === '1'){
        query = ' SELECT COUNT(1) AS USERCOUNT FROM "TECK"."TECK_USER_M_HR" WHERE LOWER(USRID) = ? AND ISDEL = \'0\' AND CSTUS = \'Active\' ';
        pstmt = conn.prepareStatement(query);
        pstmt.setNString(1, User);
        rs = pstmt.executeQuery();
        while(rs.next()){ cntt = rs.getInteger(1) || 0; }
    }
```

**CF (shipped, hand-made):**
```js
import cds from "@sap/cds";
import libEnvAth from "../../../../../Env_Config/handlers/CommonUtil.js";

async function checkAccess(req) {
  const VIEWTYPE = req.data.VIEWTYPE;
  const User = await cds.run(
    `SELECT LOWER(SESSION_CONTEXT('APPLICATIONUSER')) AS User FROM DUMMY`,
  );
  let cntt = 0;
  if (VIEWTYPE === "1") {
    const result = await cds.run(
      `SELECT COUNT(1) AS USERCOUNT FROM TECK_USER_M_HR WHERE LOWER(USRID) = ? AND ISDEL = '0' AND LOWER(CSTUS) = 'active'`,
      [User],
    );
    cntt = result.USERCOUNT || 0;
  }
```

Decomposed:

| Change | Kind |
|---|---|
| `$.import` pair → ES `import` with resolved relative path | **Deterministic** (name resolution) |
| `var` → `const`/`let` | **Deterministic** |
| `SESSION_USER` → `SESSION_CONTEXT('APPLICATIONUSER')` | **Deterministic** (item 25) |
| `"TECK"."TECK_USER_M_HR"` → `TECK_USER_M_HR` | **Deterministic** (item 8) |
| `CSTUS = 'Active'` → `LOWER(CSTUS) = 'active'` | **Deterministic** (item 24) |
| getConnection→prepareStatement→setX→executeQuery→next→getX **collapsed to one `cds.run`** | **AST-transformable** — fixed shape, needs alias tracking |
| `rs.getInteger(1)` → `result.USERCOUNT` — positional → named | **Needs the SQL parsed** for the column alias |
| `checkAccess(VIEWTYPE)` → `checkAccess(req)` + destructure | **Reasoning** — the item-14 request boundary |
| `function` → `async function`, `await` added | Rule-shaped, but applied inconsistently by hand |

### Two bugs visible in the hand-migrated reference

Worth naming, because the tool must not learn from them:

1. **`const User = await cds.run('SELECT … FROM DUMMY')` returns an array**, then
   is bound as a scalar: `[User]`. Per checklist item 16 a `SELECT` yields an
   array, so this should be `User[0].User`. As written the bind parameter is an
   array of objects.
2. **`result.USERCOUNT` on a `SELECT`** — same item-16 error. Should be
   `result[0].USERCOUNT`.

And in `Common_util` — the *simplest* file in the corpus, pure utilities with
zero `$.` calls — the conversion silently changed behaviour: `isvalidateDate`
returns `''` in NEO and `null` in CF, with the NEO version commented out above a
hand-written replacement. `async` was added to `checkLeapYear` for no reason.

**This is what "hand the file to a model and ask it to convert" produces.** The
shipped code is the output of exactly that process (the `//converted from:`
headers point at an `async_xsjs/` pipeline). Item 16 is a checklist item *because*
this keeps happening.

---

## 4. The recommended model — three tiers

### Tier 1 — deterministic AST transform (does most of the work)

Parse `.xsjs`/`.xsjslib` with `acorn` (XSJS is ES5 plus the `$` global — it
parses cleanly). Then apply typed transforms:

1. **Imports** — `$.import(pkg, lib)` + alias → ES `import`, path resolved
   against the emitted layout. Deterministic; the toolkit's
   `generator/handlerimports.js` + `resolve.js` already do this.
2. **DB collapse** — recognise the JDBC chain by data flow, not text:
   `getConnection()` → `prepareStatement(q)` → `setX(i,v)*` →
   `executeQuery()|executeUpdate()` → `next()` loop → `getX(i)`.
   Emit `await cds.run(sql, [binds])`. Resolve `getX(i)` → column name by
   parsing the SELECT list. **Decide array-vs-object from the statement kind**
   (`SELECT` → array, `CALL` with OUT params → object) — the item-16 rule,
   applied by machine instead of by memory.
3. **Request/response** — drop `$.request.method` guards and `$.net.http.*`
   constants (CAP routes); `$.request.body.asString()` → `req.data.PAYLOAD`;
   `$.response.setBody(x)` → `return x`; `$.response.status = 500` → `req.error`.
4. **Direct substitutions** — `$.session.getUsername()`, `$.util.codec.*`,
   destination calls.
5. **SQL fixes** — items 8/12/21/22/23/24/25 over every string literal that is SQL.
6. **Async propagation** — a function containing an `await` becomes `async`, and
   its callers too, computed over the call graph. *Derived, not guessed* — which
   is exactly what the hand migration got wrong.

Everything Tier 1 cannot decide becomes a **hole**: a marked node with the NEO
excerpt, the reason, and the surrounding converted context.

### Tier 2 — AI fills holes

Only what Tier 1 refused. Never the whole file "just in case".

**Built. `--ai none` (default) / `--ai claude` / `--ai "cmd:<local runner>"`.**
See SESSION-CONTEXT.md §28 for what it does, what it is worth, and the three
Tier 1 bugs that pointing a model at the refusals uncovered. Two things in the
plan below changed in the building, both in the same direction:

- **The model does not return code.** It answers one word per interpolated SQL
  value — `value` / `list` / `identifier` / `unknown` — and the conversion that
  follows is Tier 1's own code. The task table further down predicted this shape
  for `column-resolve`; it turned out to be the right shape for the only task
  that was still worth building.
- **The answer re-enters the analysis rather than the file.** Validation is not a
  separate gate that inspects a model's output: the output becomes an *input* to
  Tier 1, which then has to resolve the statement through every check it already
  applies. A model answer that survives that has passed the same bar as a
  statement no model ever saw.

### Tier 3 — human

Anything Tier 2 returns that fails validation twice.

**Both AI-mode and no-AI mode run Tier 1 identically.** No-AI mode leaves the
holes as `// NEEDS HUMAN REVIEW` with the NEO source in a comment. That is the
honest no-AI ceiling, and it is still a large amount of work removed.

---

## 5. The execution model — how prompting actually works

Your question: *"file by file, create a prompt and give to model — this is the
file, this is the prompt, convert it and give back the code?"*

**No. The unit is the function, not the file, and the model never sees a blank
page.**

### Why not file-level

- Files reach 25–49 KB (`EmailNotifications.xsjslib` is 48,924 B). One prompt,
  one shot, no verification granularity — a single bad line invalidates the whole
  answer and you cannot tell which line.
- A local on-prem model has a context budget. Whole-file blows it.
- It discards everything Tier 1 already proved. The model re-derives — and
  sometimes re-breaks — imports and SQL that were already correct.
- It is what produced the `isvalidateDate` behaviour change.

### The loop, per file

```
 1. parse NEO file  →  AST
 2. Tier 1 transform →  converted AST + holes[]
 3. if holes is empty        → emit. NO MODEL CALL. (a real fraction of files)
 4. if no-AI mode            → emit with NEEDS REVIEW markers. done.
 5. for each hole, in dependency order:
       prompt = SYSTEM  (migration rules — fixed, cacheable)
              + FACTS   (resolved imports, table names, procedure signatures,
                         result shape, the function's callers)
              + NEO     (the original function, verbatim)
              + PARTIAL (what Tier 1 already produced around it)
              + ASK     ("return only the body of function X")
    →  model returns ONE function body
 6. validate deterministically:
       parses (acorn)            · no surviving `$.` API
       same function name/arity  · every import resolves to a real emitted file
       no invented table names   · no new top-level identifiers
       SQL literals pass the same dialect checks as Tier 1
 7. pass → splice in, re-run Tier 1's fix pass over the result
    fail → retry once with the failure attached; fail again → Tier 3
 8. whole-file gate: full file parses, no `$.` survivors, imports resolve
```

Step 6 is the load-bearing one. The toolkit already states the principle:

> "A model's answer is a **proposal**; it [must pass a deterministic gate]."

The model is a suggestion engine *inside* a deterministic pipeline. It never
writes a file directly, and its output is subjected to the same checks as
Tier 1's.

### Why function-level is the right unit

- **Coherent** — a function has a contract; a span does not.
- **Verifiable** — name, arity, and return shape are checkable facts.
- **Fits a small model** — the largest single function is far smaller than the
  largest file, which matters for the on-prem model.
- **Recoverable** — one bad function is one retry, not a lost file.
- **Parallel** — independent functions convert concurrently.

### What goes in FACTS (and why it matters most)

The model's biggest failure mode is inventing names. So the prompt asserts, as
fact, everything already known:

- resolved import paths (computed, not guessed)
- the real table/view names in scope, post-schema-strip
- procedure signatures and **whether each returns OUT params or a result set**
  (settles item 16 before the model can get it wrong)
- the function's call sites — this decides the item-14 `req` boundary
- the checklist rules as constraints

Anything not in FACTS, the model is told to flag rather than invent — the same
constraint the KBs impose on humans.

---

## 6. What this means for effort

| Tier | Corpus A files | Notes |
|---|---:|---|
| Fully deterministic (views, procedures, `.xsodata`) | 644 | No model, both modes |
| Tier 1 only — JS with no holes | *unknown* | Measure it; the utility files suggest it is not small |
| Tier 1 + AI holes | the rest of 88 | |
| Out of scope | 116 | Inventoried, not converted |

The unknown row is the number worth measuring first, and it is exactly what the
scorecard is for. **Nobody knows it today** — including me. It could be 10 of 88
or 60 of 88, and the answer changes how much the AI tier matters.

---

## 7. Open questions

1. **On-prem model context window** — decides whether FACTS + NEO function +
   PARTIAL fits. Function-level was chosen partly to keep this small, but the
   number matters.
2. **`.xsjs` vs `.xsjslib`** — a `.xsjslib` is a library (functions in, functions
   out). A `.xsjs` is a service entry point, and in CAP its role is largely
   *replaced* by `service.cds` + `service.js`. The toolkit's own notes say `.xsjs`
   handling was "never evidenced in any sample". 110 files across both corpora
   need a decision: convert to a handler, or fold into the service layer?
3. **Async propagation across files** — computable within a file; across the
   import graph it needs a whole-project pass. Worth doing, since the hand
   migration demonstrably got it wrong.
4. **Do we correct the reference's bugs?** The shipped `result.USERCOUNT` on a
   `SELECT` is wrong per item 16. If the tool emits `result[0].USERCOUNT`, the
   scorecard will score it as a *mismatch* against the hand-made CF. The scorer
   needs a known-defects list, or those files stop being usable as oracles.

---

## 8. Measured: the JS problem *is* the DB problem

Added 2026-09-06, measured on Corpus A's 88 `.xsjs` + `.xsjslib` files.

### Which files need what

| Class | Files |
|---|---:|
| No `$.` at all — plain JS | 4 |
| `$.` but no DB, no outbound HTTP | 8 |
| **DB access** | **68** |
| Outbound HTTP only | 3 |
| DB + HTTP | 5 |
| | **88** |

**73 of 88 files (83%) touch the database.** Converting XSJS is not a general
"translate JavaScript" problem — it is one specific problem, 505 times.

### Shape of the 505 JDBC sites

| Construct | Count |
|---|---:|
| `prepareStatement` | **505** |
| `prepareCall` (stored procedure) | **225** |
| `executeQuery()` | 356 |
| `executeUpdate()` | 7 |
| `setX(i, v)` binds — **all positional** | **1,283** |
| `getX(N)` — **positional** | **897** |
| `getX("name")` — by name | **0** |
| `while (rs.next())` | 167 |
| `if (rs.next())` | 187 |
| `commit()` / `rollback()` / `close()` | 59 / **2** / 78 |
| SQL built by string concatenation | **109** |
| Dynamic table name in SQL | 10 |

### Why this settles the AI question

**1. Column access is 100% positional — 897 sites, zero by name.**

To convert `rs.getInteger(3)` you must know what column 3 *is*. That requires
parsing the SELECT list of the query bound to that statement. A parser does it
from the text, every time, identically. **A language model has to infer it** —
and when it is wrong the code still runs and returns the wrong column. That is
precisely the `EMP.PRLOC` / `EMP.LOCTN` class of defect the toolkit found in the
assistant's output, and the `result.USERCOUNT` bug in the shipped CF code.

Positional access is the strongest argument *for* a deterministic transform and
*against* handing files to a model.

**2. 225 `prepareCall` sites need the procedure's signature.**

Object-vs-array (checklist item 16) is decided by whether the procedure returns
OUT params or a result set. **The tool knows** — it is converting those 169
`.hdbprocedure` files in the same run, so the signature is a fact in hand. A
model would guess, and item 16 exists on the checklist because guessing here has
gone wrong repeatedly.

**3. Transaction semantics are trivial** — 2 rollbacks in the entire corpus.

**4. The genuine holes are the 109 concatenated-SQL sites** (~21%), where the
query is assembled at runtime and cannot be statically resolved. Plus the 10
dynamic table names. That is the residue Tier 2 should see — and it is a fifth of
the DB work, not all of it.

### Revised estimate

| | Sites | Tier |
|---|---:|---|
| Statically resolvable JDBC chains | ~400 of 505 | **Tier 1 — deterministic** |
| Concatenated / dynamic SQL | ~109 | Tier 2 (AI) or Tier 3 |
| Request/response, imports, codec, session | all | Tier 1 |

**The conclusion inverts the starting assumption.** The DB layer — which is the
JS layer — is *more* machine-tractable than model-tractable, because it turns on
facts the tool holds (column ordinals, procedure signatures) and the model would
have to invent. AI's job is the ~20% where the SQL genuinely is not knowable
until runtime.

### Closing the `SELECT *` risk

Positional `getX(N)` can only be resolved if the SELECT list is known. Measured
on Corpus A:

| | Count |
|---|---:|
| `SELECT *` | **4** |
| `SELECT` with explicit columns | **446** |
| `CALL` statements in JS | 315 |

**~99% of queries name their columns**, so the ordinal → column-name resolution
that Tier 1 depends on is viable across the corpus. The 4 `SELECT *` sites become
holes, like the concatenated SQL.

---

## 9. Designing for a small local model

**The question:** can a basic/medium local LLM — fast, runs on a developer's own
machine — be genuinely useful here, if the prompts are precise enough?

**Answer: yes, and the design should target that case rather than treat it as a
downgrade.** Not because small models are secretly capable, but because the tasks
left for the model are small, narrow, and verifiable. A task the model cannot
reason its way through is a task we should not be sending.

### The AI's job is smaller than the 109 concat sites suggested

Sampling those sites shows most are **statically foldable concatenation**:

```js
'SELECT COUNT(1) FROM "SYS"."USERS" WHERE USER_NAME = UPPER(\'' + user + '\')'
'GRANT ' + DB_ROLENAME + ' TO ' + PushEmployeeUserId[v]
```

Every operand is a string literal or an expression node. Folding literal+expr
concatenation into a template with `?` binds is an **AST transform**, not a
reasoning task. A second cluster is GRANT/REVOKE/CREATE USER role administration
— which migration-kb replaces with the dynamic-role-assignment template rather
than converting line by line.

So Tier 2's real residue is: dynamic table names (10), `SELECT *` (4), chains
whose statement alias escapes the function, control flow the pattern matcher
cannot follow, and genuinely runtime-assembled SQL. **Tens of sites, not
hundreds.**

### Why small models can do this

The tasks are *local pattern transformation with the facts supplied*, which is
what small models are good at. They are bad at long-range reasoning over a large
context and at knowing what they don't know — and the design removes both needs:

| Small-model weakness | How the design removes it |
|---|---|
| Long context | One function, never a 25 KB file. FACTS block instead of "go read the codebase". |
| Doesn't know project conventions | Conventions are asserted as FACTS, not expected as knowledge. |
| Invents names | Real import paths, table names and procedure signatures are given. Anything not given must be flagged. |
| Free-form drift | Ask for one function body, or JSON, never "rewrite this file". |
| Overconfidence | The deterministic gate decides, not the model's confidence. |

### Task-specific prompts, not one "convert" prompt

One generic instruction is what large models tolerate and small models fail.
Instead: a **task registry**, each with its own tight prompt, its own output
shape, and its own validator.

| Task | Input | Output | Validator |
|---|---|---|---|
| `sql-fold` | a concatenation expression | template + ordered binds | re-parse; bind count matches `?` count |
| `column-resolve` | a SELECT + an ordinal | column name | name appears in the SELECT list |
| `chain-collapse` | a JDBC chain the matcher couldn't follow | one `cds.run` call | parses; no `$.`; binds ordered |
| `req-boundary` | a function + its call sites | new signature | arity matches the call sites |
| `body-convert` | one function, last resort | one function body | parses; no `$.`; imports resolve |

Most of these return **a fragment or JSON, not code** — which is what makes a 7B
model viable. `column-resolve` returns a single identifier; that is a task a small
model does reliably and a task a large model is wasted on.

### The corpus is a free few-shot bank — and the real benchmark

There are **88 matched NEO → CF pairs** in Corpus A alone, plus 121 in Corpus B. That
gives two things no benchmark can:

1. **Retrieval few-shot.** For any hole, find the most similar already-converted
   NEO fragment and put the real before/after in the prompt. A small model with
   one on-domain example beats a large model with none — this is the single
   highest-leverage prompt decision available.
2. **The actual eval.** "Which model" is not a literature question. Run the
   scorecard (§PLAN.md 6) with each candidate and read the number. HumanEval and
   SWE-bench measure agentic multi-file coding; we are doing constrained local
   transformation with facts supplied. The rankings do not transfer.

### Candidate models — starting points, not conclusions

From current public roundups (treat as a shortlist to benchmark, not a verdict):

| Model | Size | Note |
|---|---|---|
| **Qwen2.5-Coder 7B** | ~4.7 GB | The common baseline; runs comfortably on a laptop |
| **Qwen2.5-Coder 14B** | ~9 GB | Mid-range dense code model |
| **Qwen3 7B** | — | Reported strongest sub-8B on HumanEval |
| **Qwen3-Coder-30B-A3B** | ~24 GB VRAM | MoE — 3B active, so fast despite the size |

Two practical requirements matter more than the leaderboard position:

- **Constrained/JSON output support**, so `sql-fold` and `column-resolve` can be
  schema-validated rather than regex-scraped.
- **A context window that fits FACTS + one function + surrounding code** — a few
  thousand tokens, which every model above clears easily.

An MoE like Qwen3-Coder-30B-A3B is worth testing early: only ~3B parameters are
active per token, so it can be markedly faster than a 14B dense model while
scoring better.

### The one thing that gets harder with a small model

Small models are worse at *declining*. A large model asked to convert something
ambiguous will often say so; a small one will produce confident nonsense.

So **"flag rather than guess" must be enforced by the pipeline, not requested in
the prompt.** The deterministic gate already does this. The rule to hold: never
add a validator that accepts output merely because it parses. Every task's
validator must check something semantic — bind counts, column membership, arity
against call sites. That is what makes a small model safe here, and it is worth
more than any model upgrade.

### Consequence for the build order

`--ai claude` first (fast iteration, known-good answers) to prove the *plumbing*.
Then the same tasks against a local model, and the scorecard says what the gap
actually is. If the gap is small, the tool ships as a genuinely local,
zero-cost-per-run developer tool — which is a materially better product than one
that needs a cloud key.
