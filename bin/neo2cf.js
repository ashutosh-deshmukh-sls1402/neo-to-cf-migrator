#!/usr/bin/env node
/**
 * neo2cf — convert a SAP NEO codebase into a SAP CF (CAP) codebase.
 *
 * Arg parsing and rendering only. All behaviour lives in src/ and is reachable
 * programmatically, so a UI can drive the same code without going through here.
 */

import path from 'node:path';
import { inventory } from '../src/index.js';
import { convert } from '../src/convert.js';
import { writeFiles } from '../src/core/write.js';
import { score } from '../score/compare.js';
import { scanDb, convertFile } from '../src/transform/scan.js';
import { renderInventory, renderScore, renderConvert, renderDbScan, renderError } from '../src/report/render.js';
import { resolveBackend } from '../src/ai/backend.js';
import { formatJs } from '../src/emit/format.js';

const HELP = `
neo2cf — SAP NEO (XSJS/XSC) -> SAP CF (CAP/Node.js)

USAGE
  neo2cf inventory <neo-dir> [options]          survey the tree; converts nothing
  neo2cf dbscan <neo-dir>                       how much .xsjs database access converts automatically
  neo2cf dbscan <neo-dir> --show <rel-path>     convert one file and print it
  neo2cf convert <neo-dir> -o <out-dir>         convert; dry run unless --write
  neo2cf score <neo-dir> --expect <cf-dir>      score the mapping against a hand-migrated CF tree

OPTIONS
  --schema <name>     override the inferred schema (e.g. TECK)
  --app <a,b>         override the inferred <APP> segment(s)
  -o, --out <dir>     where the CF tree is written
  --write             actually write (default is a dry run)
  --force             write even with blockers outstanding
  --json              machine-readable output
  --single-cds        put every CDS proxy entity in one db/cds/schema.cds
                      instead of one .cds per calc view (the default)
  --module-cds        one .cds per top-level module instead:
                      db/cds/<MODULE>/<MODULE>_schema.cds
  --root-package <p>  package segments above the directory being converted,
                      when it is a subfolder of the NEO repository (e.g. RSM).
                      Inferred from the .xsodata references; pass "" to take
                      the folder paths literally
  --no-format         skip the final Prettier pass over the emitted .js.
                      Everything else splices, so without formatting the
                      output still diffs line-for-line against the NEO source
  --ai <backend>      Tier 2 — ask a model about what Tier 1 refused. Default none.
                        none              deterministic only (the default)
                        claude            the claude CLI, headless (claude -p)
                        cmd:<command>     any local runner reading stdin,
                                          e.g. --ai "cmd:ollama run qwen2.5-coder"
                      A model only ever answers a question; the conversion is
                      emitted by the same deterministic code either way.
  --help, -h

Nothing is written to the NEO tree, ever. Conversion commands land in later
phases; see docs/PLAN.md.
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    // Short flags that take a value. Kept as an explicit list so an unknown
    // single-dash argument is reported rather than silently swallowing the next one.
    if (a === '-o') { flags.out = argv[++i]; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return { flags, positional };
}

/** --single-cds / --module-cds -> cdsProxy.bundle. Neither = one .cds per view. */
const cdsBundle = (flags) => (flags['module-cds'] ? 'module' : flags['single-cds'] ? 'all' : null);

const list = (v) => (v && v !== true ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const [command, target] = positional;

  if (flags.help || !command) { process.stdout.write(HELP); return 0; }

  let ai = null;
  try { ai = resolveBackend(flags.ai); } catch (err) { process.stderr.write(renderError(err)); return 1; }

  if (command === 'convert') {
    const outDir = typeof flags.out === 'string' ? flags.out : (typeof flags.o === 'string' ? flags.o : null);
    if (!target) { process.stderr.write(renderError(new Error('convert needs a path to the NEO tree.'))); return 1; }
    if (flags.write && !outDir) { process.stderr.write(renderError(new Error('--write needs -o <out-dir>.'))); return 1; }
    try {
      const r = convert(path.resolve(target), {
        schema: typeof flags.schema === 'string' ? flags.schema : undefined,
        apps: list(flags.app),
        ai,
        config: {
          ...(cdsBundle(flags) ? { cdsProxy: { bundle: cdsBundle(flags) } } : {}),
          ...(typeof flags['root-package'] === 'string' ? { rootPackage: { package: flags['root-package'] } } : {}),
        },
      });
      // Last, after every offset-based pass: Prettier rewrites the whole file.
      if (!flags['no-format']) {
        const fmt = await formatJs(r.files);
        for (const f of fmt.failed) {
          r.findings.push({
            level: 'warning', code: 'FORMAT_FAILED', file: f.file,
            message: `${f.file}: Prettier could not parse the converted file, so it is written unformatted.`,
            fix: `A file that will not parse here will not run either — ${f.message}`,
          });
        }
      }
      let wrote = null;
      let refused = null;
      if (flags.write) {
        try {
          wrote = writeFiles(r.files, path.resolve(outDir), path.resolve(target), { force: !!flags.force, blockers: r.stats.blocked });
        } catch (err) {
          // The refusal is the guard doing its job, but its message says to go
          // and read the blockers — so the report has to be printed, not
          // replaced by the refusal. It follows the report, below.
          refused = err;
        }
      }
      const asJson = () =>
        JSON.stringify(
          { ...r, files: r.files.map((f) => ({ path: f.path, role: f.role, bytes: f.text.length })) },
          null,
          2,
        ) + '\n';
      process.stdout.write(
        flags.json ? asJson() : renderConvert(r, { outDir: outDir ? path.resolve(outDir) : null, wrote }),
      );
      if (refused) { process.stderr.write(renderError(refused)); return 1; }
      return r.stats.blocked && !flags.force ? 1 : 0;
    } catch (err) { process.stderr.write(renderError(err)); return 1; }
  }

  if (command === 'dbscan') {
    if (!target) { process.stderr.write(renderError(new Error('dbscan needs a path to the NEO tree.'))); return 1; }
    // --show converts one file and prints it, so the output can be read before
    // any of it is written anywhere.
    if (typeof flags.show === 'string') {
      try {
        const r = convertFile(path.resolve(target), flags.show, {
          schema: typeof flags.schema === 'string' ? flags.schema : undefined,
          apps: list(flags.app),
          ai,
        });
        process.stderr.write(
          `\n  ${flags.show}\n  ${r.converted} statement(s) converted, ${r.skipped} left for a human\n` +
            r.notes.map((n) => `  · ${n}\n`).join('') + '\n',
        );
        // Formatted like `convert` would write it, so the preview is the file.
        const preview = [{ path: `${flags.show}.js`, text: r.text }];
        if (!flags['no-format']) await formatJs(preview);
        process.stdout.write(preview[0].text);
        return 0;
      } catch (err) { process.stderr.write(renderError(err)); return 1; }
    }
    try {
      const r = scanDb(path.resolve(target), {
        schema: typeof flags.schema === 'string' ? flags.schema : undefined,
        apps: list(flags.app),
        ai,
      });
      process.stdout.write(
        flags.json
          ? JSON.stringify({ ...r, files: r.files.map(({ chains, ...f }) => f) }, null, 2) + '\n'
          : renderDbScan(r),
      );
      return 0;
    } catch (err) { process.stderr.write(renderError(err)); return 1; }
  }

  if (command === 'score') {
    if (!target || typeof flags.expect !== 'string') {
      process.stderr.write(renderError(new Error('score needs a NEO path and --expect <cf-dir>.')));
      return 1;
    }
    try {
      const r = score(path.resolve(target), path.resolve(flags.expect), {
        schema: typeof flags.schema === 'string' ? flags.schema : undefined,
        apps: list(flags.app),
      });
      r.expectedRoot = path.resolve(flags.expect);
      process.stdout.write(flags.json ? JSON.stringify(r, null, 2) + '\n' : renderScore(r));
      return 0;
    } catch (err) {
      process.stderr.write(renderError(err));
      return 1;
    }
  }

  if (command !== 'inventory') {
    process.stderr.write(renderError(new Error(`Unknown command "${command}". Try: neo2cf --help`)));
    return 1;
  }
  if (!target) {
    process.stderr.write(renderError(new Error('inventory needs a path to the NEO tree.')));
    return 1;
  }

  try {
    const result = inventory(path.resolve(target), {
      schema: typeof flags.schema === 'string' ? flags.schema : undefined,
      apps: list(flags.app),
    });
    process.stdout.write(flags.json ? JSON.stringify(result, null, 2) + '\n' : renderInventory(result));
    return 0;
  } catch (err) {
    process.stderr.write(renderError(err));
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
