# neo-to-cf-migrator

Converts a SAP NEO (XSJS/XSC) codebase into a SAP CF (CAP/Node.js) codebase,
mirroring the NEO folder structure. Deterministic first; AI only where a parser
genuinely cannot decide.

```bash
npm install
node bin/neo2cf.js inventory <neo-dir>                    # survey; converts nothing
node bin/neo2cf.js dbscan    <neo-dir>                    # how much .xsjs DB access converts automatically
node bin/neo2cf.js dbscan    <neo-dir> --show <rel-path>  # convert one file and print it
node bin/neo2cf.js convert   <neo-dir> -o <out> --write   # dry run without --write
node bin/neo2cf.js score     <neo-dir> --expect <cf-dir>  # score against a hand-migrated tree
node bin/neo2cf.js convert   <neo-dir> -o <out> --write --module-cds  # one .cds per module
node bin/neo2cf.js convert   <neo-dir> -o <out> --write --ai claude   # + Tier 2
node test/run.js                                          # 345 tests
npm run verify -- <neo-dir> --cds <path-to-cds>            # the whole sweep, incl. cds build

```

**Status: every artifact type converts.** `.calculationview`, `.hdbprocedure`
and `.xsodata` are done. For `.xsjs`/`.xsjslib`, JDBC becomes `await cds.run`:
**655 of 673** statements on one corpus and **1,073 of 1,123** on another, with
every rewritten file re-parsed to prove it still loads and every refusal named,
counted and pointed at a file. `$.import` becomes an ES import — 322 resolved,
**none pointing at the wrong file** when checked against a hand-migrated tree.
`$.request`/`$.response`/`$.session` become `req` / `cds.context`, the hand-rolled
method dispatch collapses because CAP routes, and 57 request entry points are
found and exported — leaving **132 of ~1,000 `$.` sites** across both corpora in the output, each in a
file that carries a named finding (`checks/leaks.js` proves it). `convert` writes all of it: **1,662 files on one corpus, 87 of
them handlers, no blockers — and the result passes `cds build --production`
with 0 errors.** Outbound HTTP becomes `executeHttpRequest` —
**59 of 63** calls. Scored against a hand-migrated tree the emitted paths are
**99.9%** right. See
[`SESSION-CONTEXT.md`](SESSION-CONTEXT.md) §0 for what is done and what is not.

Two things the per-file view cannot see, and `convert` now fixes because it
holds the whole tree: **1,275 missing cross-file `await`s** — a Promise used as
a value, which fails silently rather than throwing, and was the largest defect
class in the output by twenty to one — and the project shell below.

**Tier 2 is optional and off by default.** `--ai claude`, or `--ai "cmd:<any
local runner>"`, asks a model only about statements Tier 1 refused *and* that
one answer would convert. The model answers a question — never code — the answer
goes back through Tier 1, which decides, and the SQL grammar overrules the model
where it can. On the two corpora it settled 16 statements, each marked
`AI-CLASSIFIED` in the file it landed in.

Two checks run over the emitted tree and need no reference codebase: every
relative import must resolve to a file the tool also emits (421 of 429 do; the
rest are already flagged), and every function an `.xsodata` wires up must be
exported by its handler (18 are not — the function does not exist in NEO either).

The strongest check is not ours. `convert` also emits the project shell —
`package.json`, `mta.yaml`, `srv/index.cds`, `xs-security.json` — so the output
can be handed straight to CAP's own compiler, which is the only thing that knows
what CAP will accept:

```bash
node bin/neo2cf.js convert <neo-dir> -o out --write
cd out && npm install && npx cds build --production
```

Doing that the first time found five defects nothing else could see — including
a CDS type that does not exist. `SESSION-CONTEXT.md` §23 has all five. It is no
longer a manual step: `npm run verify` runs it, along with the tests, both
conversions, the emitted-tree checks and the scorecard, and exits non-zero if
any of them fails.

## Docs

| Doc | What |
|---|---|
| [`docs/USAGE.md`](docs/USAGE.md) | **Start here to use it** — every command, reading the output, verifying, troubleshooting |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | **Start here to change it** — the rules, the map, one `convert` run end to end |
| [`SESSION-CONTEXT.md`](SESSION-CONTEXT.md) | Status, decisions, measurements, build log |
| [`docs/CONVERSION-STRATEGY.md`](docs/CONVERSION-STRATEGY.md) | Per-artifact strategy, the three tiers, the prompting model, small-model design |
| [`docs/PLAN.md`](docs/PLAN.md) | The original build plan and phase order — historical; `ARCHITECTURE.md` supersedes its pipeline section |
| [`docs/UNDERSTANDING.md`](docs/UNDERSTANDING.md) | The survey the above rests on |

## Design rules

1. Never write to the NEO tree — enforced in code, not by convention.
2. Dry-run is the default; `--write` is explicit; a blocker stops it unless `--force`.
3. NEO is the source of truth.
4. **A rule that cannot decide deterministically emits a finding, not a guess.**
5. **The AST locates; the original text is edited by offset.** JavaScript is
   never regenerated from the parse tree — that would reformat all 88 files and
   drop every comment, leaving nothing to diff against the NEO original.

Rule 4 is load-bearing. `inventory` on Corpus B reports that it cannot identify the
`<APP>` segment rather than picking one, because that segment is dropped from
`db/` paths and a wrong guess silently merges unrelated subtrees.

Only `bin/` and `src/report/` may write to a terminal. Everything else returns
data, so a UI is a rendering job later rather than a rewrite.

## Layout

```
bin/neo2cf.js        CLI — arg parsing and rendering only
src/
  convert.js         the pipeline: parse everything, then emit everything
  core/              intake, config, layout, naming, write guards
  parse/             calcview, sqlscript, xsodata, procsig
  transform/         file (composes the passes), js (parse/walk/splice),
                     db (JDBC analysis), emitdb (cds.run), imports ($.import),
                     request ($.request/$.response + the entry function),
                     http (destination calls), scan
  emit/              hdbcalcview, hdbfunction, cdsproxy, servicecds, servicejs,
                     project (package.json, mta.yaml, srv/index.cds, …),
                     awaits (cross-file await, over the whole emitted tree)
  ai/                Tier 2 — the only non-deterministic code in the tool
  report/render.js   terminal output
score/compare.js     scorecard — runs convert() and scores the files it wrote
checks/              verify.js  (THE SWEEP — everything below, plus cds build),
                     ceiling.js (what each refusal is worth),
                     leaks.js   (what is left of the $. surface),
                     awaits.js  (every cross-file async call is awaited),
                     emitted.js (scope / sentinel / re-parse over an out-dir)
test/                345 tests, no framework
```

Several modules are ported from `C:\Sodales\Tools\migration-cleanup-toolkit`
(validated against a 587-view corpus) and are marked as such in their header. Do
not retune them without re-running `score`.
