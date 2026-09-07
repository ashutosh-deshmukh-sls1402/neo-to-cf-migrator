# Graph Report - neo-to-cf-migrator  (2026-09-07)

## Corpus Check
- 64 files · ~76,585 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 459 nodes · 1085 edges · 14 communities (13 shown, 1 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 52 edges (avg confidence: 0.89)
- Token cost: 137,847 input · 0 output

## Community Hubs (Navigation)
- Cross-File Awaits and Output Checks
- CLI, Write Guards and Usage
- Conversion Pipeline and Naming
- Tiers, Findings and Verification
- JDBC Chain Analysis
- Calculation View Pipeline
- Intake and NEO-to-CF Path Mapping
- Refusal Ceilings and Scorecard
- Request and HTTP Passes
- Package Manifest
- CAP Project Shell
- The Verify Sweep Runner
- Test Runner
- Exit Codes

## God Nodes (most connected - your core abstractions)
1. `transformFile()` - 36 edges
2. `convert()` - 32 edges
3. `walk()` - 28 edges
4. `parse()` - 25 edges
5. `analyseDb()` - 21 edges
6. `discover()` - 19 edges
7. `dbEdits()` - 17 edges
8. `main()` - 16 edges
9. `buildChain()` - 16 edges
10. `targetsFor()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `The complete artifact taxonomy` --references--> `classifyFile()`  [INFERRED]
  docs/CONVERSION-STRATEGY.md → src/core/artifacts.js
- `Phase B — resolve names (the proxies map)` --references--> `targetsFor()`  [INFERRED]
  docs/ARCHITECTURE.md → src/core/layout.js
- `SQL_IDENTIFIER_INTERPOLATED` --references--> `cfSql()`  [INFERRED]
  docs/USAGE.md → src/transform/emitdb.js
- `The nine-pass pipeline` --references--> `convert()`  [INFERRED]
  docs/PLAN.md → src/convert.js
- `Troubleshooting table` --references--> `discover()`  [EXTRACTED]
  docs/USAGE.md → src/core/intake.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **The five rules everything obeys (plus the applyEdits rule)** — docs_architecture_rule_never_write_neo_tree, docs_architecture_rule_dry_run_default, docs_architecture_rule_finding_not_guess, docs_architecture_rule_ast_locates_text_edited, docs_architecture_rule_terminal_boundary, docs_architecture_rule_single_applyedits [EXTRACTED 1.00]
- **One convert run, end to end** — docs_architecture_phase_intake, docs_architecture_phase_a_parse, docs_architecture_phase_b_resolve_names, docs_architecture_phase_c_emit, docs_architecture_whole_tree_passes, docs_architecture_write_phase, src_convert_convert [EXTRACTED 1.00]
- **The three-tier conversion model and its gate** — docs_conversion_strategy_tier_1_deterministic, docs_conversion_strategy_tier_2_ai_fills_holes, docs_conversion_strategy_tier_3_human, docs_conversion_strategy_hole, docs_conversion_strategy_deterministic_gate, docs_architecture_tier2_has_no_emitter [EXTRACTED 1.00]

## Communities (14 total, 1 thin omitted)

### Community 0 - "Cross-File Awaits and Output Checks"
Cohesion: 0.07
Nodes (48): problems, roots, roots, checks/emitted.js — scope, sentinels, re-parse, The re-parse gate, Rule 6 — all passes contribute edits to one applyEdits call, Whole-tree passes, Tier 1 — deterministic AST transform (+40 more)

### Community 1 - "CLI, Write Guards and Usage"
Cohesion: 0.06
Nodes (50): main(), parseArgs(), Rule 4 — the AST locates, the original text is edited by offset, Rule 2 — dry run is the default, Rule 1 — never write to the NEO tree, Rule 5 — only bin/ and src/report/ may write to a terminal, Write phase and the two write guards, The corpus as a retrieval few-shot bank (+42 more)

### Community 2 - "Conversion Pipeline and Naming"
Cohesion: 0.07
Nodes (36): roots, tally, unaccounted, Phase B — resolve names (the proxies map), Phase C — emit file text, The 7c-vs-14 request boundary, The entity-name flattening rule, The numeric-leading identifier rule (+28 more)

### Community 3 - "Tiers, Findings and Verification"
Cohesion: 0.05
Nodes (41): AI-CLASSIFIED marker, Rules for adding an AI task, cds build --production — the only real oracle, The ceiling rule, checks/awaits.js — every cross-file async call awaited, checks/ceiling.js — what each refusal is worth, checks/leaks.js — the remaining $. surface, Finding levels — note / warning / blocked (+33 more)

### Community 4 - "JDBC Chain Analysis"
Cohesion: 0.10
Nodes (40): Analysis / emission split (db.js vs emitdb.js), Hole (a marked unresolved node), JDBC chain collapse to await cds.run, Positional column access (897 getX(N), zero by name), Statically foldable concatenation (sql-fold), transform/db.js as the centrepiece, aliasUnnamedColumns(), analyseDb() (+32 more)

### Community 5 - "Calculation View Pipeline"
Cohesion: 0.11
Nodes (34): Backwards information flow (xsodata keys into the CDS proxy), Phase A — parse every file into data, The calc-view 1:1:1:1 pipeline, cdsType(), DEFAULT_TYPE_MAP, generateProxy(), NO_LENGTH, pad() (+26 more)

### Community 6 - "Intake and NEO-to-CF Path Mapping"
Cohesion: 0.13
Nodes (27): Path asymmetry — db/ drops <APP>, srv/lib keeps it, Intake phase, .xsjs placement — settled by evidence, The verified NEO → CF folder mapping, The output tree layout, classifyFile(), classifyFolder(), extensionOf() (+19 more)

### Community 7 - "Refusal Ceilings and Scorecard"
Cohesion: 0.09
Nodes (26): args, ceiling, codeAt, codes, raw, roots, sites, total (+18 more)

### Community 8 - "Request and HTTP Passes"
Cohesion: 0.20
Nodes (24): JS pass order (imports → request → http → db → async), Rewrite around a sub-expression, never over it, The XSJS API surface is a closed set, refPath(), analyseHttp(), assignedTo(), buildChain(), HTTP_METHOD (+16 more)

### Community 9 - "Package Manifest"
Cohesion: 0.11
Nodes (18): acorn, fast-xml-parser, bin, neo2cf, dependencies, acorn, fast-xml-parser, description (+10 more)

### Community 10 - "CAP Project Shell"
Cohesion: 0.21
Nodes (14): SQL_IDENTIFIER_INTERPOLATED, What still needs a human, Project shell emission, dbPackageJson(), generateProject(), ID(), mtaYaml(), npmName() (+6 more)

### Community 11 - "The Verify Sweep Runner"
Cohesion: 0.18
Nodes (8): argv, cds, expect, failures, outRoot, outs, repo, roots

### Community 12 - "Test Runner"
Cohesion: 0.50
Nodes (3): failures, files, here

## Ambiguous Edges - Review These
- `relSpecifier()` → `The entity-name flattening rule`  [AMBIGUOUS]
  docs/UNDERSTANDING.md · relation: references
- `Corpus A (TECK) — the output-shape reference` → `The three scorecard exclusions`  [AMBIGUOUS]
  docs/PLAN.md · relation: references

## Knowledge Gaps
- **76 isolated node(s):** `roots`, `problems`, `args`, `codeAt`, `roots` (+71 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 111 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `relSpecifier()` and `The entity-name flattening rule`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `Corpus A (TECK) — the output-shape reference` and `The three scorecard exclusions`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **Why does `convert()` connect `Conversion Pipeline and Naming` to `Cross-File Awaits and Output Checks`, `CLI, Write Guards and Usage`, `Calculation View Pipeline`, `Intake and NEO-to-CF Path Mapping`, `Refusal Ceilings and Scorecard`, `CAP Project Shell`?**
  _High betweenness centrality (0.112) - this node is a cross-community bridge._
- **Why does `transformFile()` connect `Cross-File Awaits and Output Checks` to `CLI, Write Guards and Usage`, `Conversion Pipeline and Naming`, `Intake and NEO-to-CF Path Mapping`, `Refusal Ceilings and Scorecard`, `Request and HTTP Passes`?**
  _High betweenness centrality (0.091) - this node is a cross-community bridge._
- **Why does `parse()` connect `Cross-File Awaits and Output Checks` to `Conversion Pipeline and Naming`, `JDBC Chain Analysis`, `Refusal Ceilings and Scorecard`?**
  _High betweenness centrality (0.070) - this node is a cross-community bridge._
- **Are the 4 inferred relationships involving `transformFile()` (e.g. with `Tier 1 — deterministic AST transform` and `indentOf()`) actually correct?**
  _`transformFile()` has 4 INFERRED edges - model-reasoned connections that need verification._
- **Are the 3 inferred relationships involving `convert()` (e.g. with `The nine-pass pipeline` and `.resolve()`) actually correct?**
  _`convert()` has 3 INFERRED edges - model-reasoned connections that need verification._