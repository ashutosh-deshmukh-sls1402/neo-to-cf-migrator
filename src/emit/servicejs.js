/**
 * Generate `service.js` — the thin CAP handler wiring.
 *
 * No counterpart in migration-cleanup-toolkit: it checks handlers but never
 * authors this file. It is nonetheless fully deterministic, because the
 * `.xsodata` already says exactly which function serves which alias:
 *
 *   "…Views::TECK_JB_Clob" as "hsc3ogvpw9briuci"
 *   create using "TECK.…JB_ALDRFTPOST.Library:TECK_HR_CreateAllDraftPosting.xsjslib::createJobBid";
 *                 └──────────── library package ────────────┘ └──── file ────┘  └── function ──┘
 *
 * becomes
 *
 *   import { createJobBid } from "../Library/handlers/TECK_HR_CreateAllDraftPosting.js";
 *   srv.on("hsc3ogvpw9briuci", async (req) => await createJobBid(req));
 *
 * Two checklist rules are structural here and so are satisfied by construction:
 *   item 7a — ES `import`, never `require()`
 *   item 7b — the event name is the alias, never the literal 'CREATE'
 *   item 14 — `req` is passed straight through to the Library entry function;
 *             extracting PAYLOAD is that function's job, not this file's.
 *
 * Entities with no `create using` need no handler: CAP serves a read-only
 * projection directly from the model.
 */

import path from 'node:path';
import { importSpecifier } from '../core/layout.js';

/**
 * `TECK.JOB_BIDDING.COMMON_View.Library:CommonUtil.xsjslib`
 *   -> srv/lib/TECK/JOB_BIDDING/COMMON_View/Library/handlers/CommonUtil.js
 *
 * The package path before the `:` mirrors the NEO folder tree, with the schema
 * as its first segment — the same layout srv/lib uses, so the mapping is a
 * straight substitution rather than a lookup.
 */
export function handlerPathFor(libRef, schema) {
  const [pkg, file] = String(libRef).split(':');
  if (!pkg || !file) return null;
  const segs = pkg.split('.').filter(Boolean);
  // Drop the leading schema segment if present; srv/lib re-adds it.
  if (segs[0] === schema) segs.shift();
  const stem = file.replace(/\.(xsjslib|xsjs)$/i, '');
  return `srv/lib/${schema}/${segs.join('/')}/handlers/${stem}.js`;
}

/** A JS identifier that is safe to use as an import binding. */
const safeIdent = (s) => String(s).replace(/[^A-Za-z0-9_$]/g, '_');

/**
 * @param {object} parsed  parseXsodata() output
 * @param {object} opts
 * @param {string} opts.schema
 * @param {string} opts.outPath   where this service.js will be written, repo-relative
 * @returns {{text:string, bindings:number, imports:number, warnings:string[]}}
 */
export function generateServiceJs(parsed, opts = {}) {
  const { schema, outPath } = opts;
  if (!schema) throw new Error('generateServiceJs requires opts.schema');
  if (!outPath) throw new Error('generateServiceJs requires opts.outPath');

  const warnings = [];
  const entities = (parsed.entities || []).filter((e) => e.createUsing);

  // Group by target file so each library is imported once.
  const byFile = new Map();
  const bindings = [];
  const usedNames = new Map(); // local binding -> source file, to catch collisions

  for (const e of entities) {
    const target = handlerPathFor(e.createUsing.lib, schema);
    if (!target) {
      warnings.push(
        `Could not resolve the library reference "${e.createUsing.raw}" for alias "${e.alias}". ` +
          'The handler import is missing; wire it by hand.',
      );
      continue;
    }

    const fn = e.createUsing.func;

    // The imported name is emitted verbatim — `import { fn as local }` — so it
    // has to be an identifier. One `create using` in the corpus reads
    // `…CommonUtil.xsjslib::ErrorHandling::ErrorHandling`, a NEO typo that does
    // not match the `package:file::function` grammar at all. Emitting it broke
    // the whole service.js. Taking the last segment would be a guess about
    // which half the author meant, so this refuses and says so.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fn)) {
      warnings.push(
        `"${e.createUsing.raw}" does not name a function — "${fn}" is not an identifier. ` +
          `Alias "${e.alias}" is left unwired.`,
      );
      continue;
    }

    let local = safeIdent(fn);

    // Two libraries can export the same function name. Alias the second rather
    // than silently shadowing the first.
    const owner = usedNames.get(local);
    if (owner && owner !== target) {
      const suffix = safeIdent(path.basename(target, '.js'));
      local = `${local}$${suffix}`;
      warnings.push(
        `"${fn}" is exported by more than one library; imported here as "${local}" to avoid a clash.`,
      );
    }
    usedNames.set(local, target);

    if (!byFile.has(target)) byFile.set(target, new Map());
    byFile.get(target).set(local, fn);

    bindings.push({ alias: e.alias, local, fn, target });
  }

  // Deterministic order: imports by path, handlers in .xsodata order.
  const importLines = [...byFile.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([target, names]) => {
      const spec = importSpecifier(outPath, target);
      const list = [...names.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([local, fn]) => (local === fn ? local : `${fn} as ${local}`))
        .join(', ');
      return `import { ${list} } from '${spec}';`;
    });

  const handlerLines = bindings.map(
    // item 7b: the event is the alias. item 14: req goes straight through.
    (b) => `  srv.on('${b.alias}', async (req) => await ${b.local}(req));`,
  );

  if (!bindings.length) {
    // A service of pure read-only projections is legitimate and needs no code,
    // but an empty default export keeps CAP's file discovery happy.
    return {
      text:
        '// Every entity in this service is a read-only projection; CAP serves them\n' +
        '// directly from the model, so there is nothing to wire here.\n' +
        'export default () => {};\n',
      bindings: 0,
      imports: 0,
      warnings,
    };
  }

  const text = `${importLines.join('\n')}\n\nexport default (srv) => {\n${handlerLines.join('\n')}\n};\n`;
  // `wired` is what the caller cross-checks against the handlers it emitted: a
  // `create using` naming a function the library does not declare wires an
  // entity to nothing, and CAP only says so at startup.
  return { text, bindings: bindings.length, wired: bindings, imports: byFile.size, warnings };
}
