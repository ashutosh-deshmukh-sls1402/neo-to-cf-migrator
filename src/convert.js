/**
 * The conversion pipeline.
 *
 * Parse everything, then emit everything. The two phases cannot be merged
 * because information flows backwards: a CDS proxy's `key` columns are declared
 * in the `.xsodata` that projects it (checklist item 5), and a `service.cds`
 * needs the proxy names the calc-view pass produces. Emitting as we walk would
 * mean either a missing key or a forward reference.
 *
 * Returns files; writes nothing. The caller decides what to do with them, which
 * is what keeps `--write` a separate, explicit step and lets a UI reuse all of
 * this untouched.
 */

import fs from 'node:fs';
import path from 'node:path';

import { discover } from './core/intake.js';
import { resolveConfig } from './core/config.js';
import { KIND } from './core/artifacts.js';
import { flattenEntityName, RenameRegistry, startsWithDigit } from './core/naming.js';
import { targetsFor } from './core/layout.js';

import { parseCalcView } from './parse/calcview.js';
import { parseXsodata } from './parse/xsodata.js';
import { transformFile } from './transform/file.js';
import { parse as parseJs } from './transform/js.js';
import { indexFromIntake } from './parse/procsig.js';

import { generateFunction } from './emit/hdbfunction.js';
import { generateCalcView } from './emit/hdbcalcview.js';
import { generateProxy } from './emit/cdsproxy.js';
import { generateServiceBlock, assignServiceNames } from './emit/servicecds.js';
import { generateServiceJs } from './emit/servicejs.js';
import { generateProject } from './emit/project.js';
import { propagateAwaits } from './emit/awaits.js';

const posix = (p) => p.split(path.sep).join('/');

const finding = (level, code, message, extra = {}) => ({ level, code, message, ...extra });

/**
 * @param {string} neoRoot
 * @param {object} [opts] { schema, apps, config }
 */
export function convert(neoRoot, opts = {}) {
  const intake = discover(neoRoot, { schema: opts.schema, apps: opts.apps });
  const procs = indexFromIntake(neoRoot, intake);
  const cfg = resolveConfig(opts.config ?? {}, intake);
  const schema = cfg.schema;
  const app = cfg.apps[0] ?? null;

  const files = [];
  /** Schemas the tree reads and does not own — they become mta.yaml resources. */
  const foreignSchemas = new Set(intake.schemaEvidence.filter((e) => e.name !== schema).map((e) => e.name));
  const findings = intake.warnings.map((w) => finding('warning', w.code, w.message, { fix: w.fix }));

  if (!schema) {
    findings.push(
      finding('blocked', 'NO_SCHEMA', 'Cannot convert without a schema.', {
        fix: 'Pass --schema <name>; it is the first segment of the $.import package path.',
      }),
    );
    return { intake, cfg, files, findings, stats: {} };
  }

  const renames = new RenameRegistry({ prefix: cfg.naming.numericLeadingPrefix });

  /* ------------------------------------------------------------------ */
  /* PHASE A — parse                                                     */
  /* ------------------------------------------------------------------ */

  /** NEO `namespace::entity` -> { name, file, cv, neoPath } */
  const proxies = new Map();
  /** NEO `namespace::entity` -> Set of key column names, gathered from every .xsodata */
  const keysFor = new Map();
  const calcViews = [];
  const services = [];
  const procedures = [];
  const libraries = [];

  for (const unit of intake.units) {
    for (const file of unit.files) {
      const rel = unit.neoDir ? `${unit.neoDir}/${file}` : file;
      const abs = path.join(neoRoot, rel);
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        findings.push(finding('blocked', 'UNREADABLE', `Could not read ${rel}: ${err.message}`, { file: rel }));
        continue;
      }

      if (unit.kind === KIND.CALCVIEW) {
        const cv = parseCalcView(text, abs);
        if (cv.classification === 'UNPARSED') {
          findings.push(
            finding('blocked', 'CALCVIEW_UNPARSED', `${rel}: ${cv.error ?? 'could not be parsed'}`, { file: rel }),
          );
          continue;
        }
        if (cv.classification !== 'PURE_SCRIPT') {
          findings.push(
            finding('warning', 'CALCVIEW_NOT_PURE_SCRIPT',
              `${rel} is ${cv.classification}: it layers other nodes on top of the script, so generating ` +
              'from the script alone would lose modelling work.',
              { file: rel, fix: 'Migrate this view by hand, or confirm the extra nodes are inert.' }),
          );
        }
        calcViews.push({ rel, cv, neoDir: unit.neoDir });
      } else if (unit.kind === KIND.SERVICE) {
        const parsed = parseXsodata(text);
        for (const u of parsed.unparsed ?? []) {
          findings.push(
            finding('warning', 'XSODATA_UNPARSED', `${rel}: could not parse a statement — ${String(u).slice(0, 120)}`, { file: rel }),
          );
        }
        // Keys travel backwards into the proxies.
        for (const ent of parsed.entities ?? []) {
          const id = `${ent.namespace}::${ent.entity}`;
          if (!keysFor.has(id)) keysFor.set(id, new Set());
          for (const k of ent.keys ?? []) keysFor.get(id).add(k);
        }
        services.push({ rel, parsed, neoDir: unit.neoDir, file });
      } else if (unit.kind === KIND.PROCEDURE) {
        procedures.push({ rel, text, neoDir: unit.neoDir, file });
      } else if (unit.kind === KIND.LIBRARY) {
        libraries.push({ rel, text });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* PHASE B — resolve names                                             */
  /* ------------------------------------------------------------------ */

  for (const { rel, cv, neoDir } of calcViews) {
    const base = path.basename(rel).replace(/\.(calculationview|hdbcalculationview)$/i, '');
    const container = flattenEntityName([schema, ...neoDir.split('/').filter(Boolean)].join('.'));
    const entityName = `${container}_${base}`.toUpperCase();
    const functionName = `${container}_${cfg.naming.functionFilePrefix}${base}`.toUpperCase();
    // The NEO id the .xsodata refers to is namespace::filename, not the internal
    // scenario id — 92 of those disagree with their filename corpus-wide.
    const neoId = `${[schema, ...neoDir.split('/').filter(Boolean)].join('.')}::${base}`;
    const cdsFile = targetsFor({ relPath: rel, kind: KIND.CALCVIEW, schema, app, entityName })
      .find((t) => t.role === 'cdsproxy').path;

    proxies.set(neoId, { name: entityName, file: cdsFile, functionName, base, cv, rel, neoDir });
  }

  /* ------------------------------------------------------------------ */
  /* PHASE C — emit                                                      */
  /* ------------------------------------------------------------------ */

  const emit = (p, text, role, source) => files.push({ path: p, text, role, source });

  // --- calc views: three files each ---
  for (const { rel, cv, neoDir } of calcViews) {
    const base = path.basename(rel).replace(/\.calculationview$/i, '');
    const neoId = `${[schema, ...neoDir.split('/').filter(Boolean)].join('.')}::${base}`;
    const px = proxies.get(neoId);
    const targets = targetsFor({ relPath: rel, kind: KIND.CALCVIEW, schema, app, entityName: px.name });
    const container = px.functionName.replace(new RegExp(`_${cfg.naming.functionFilePrefix}.*$`), '');

    try {
      const fn = generateFunction(cv, cfg, { containerPath: container, functionBaseName: base });
      emit(targets.find((t) => t.role === 'tablefunction').path, fn.text, 'tablefunction', rel);
      for (const w of fn.warnings) findings.push(finding('warning', 'FUNCTION', `${rel}: ${w}`, { file: rel }));
      for (const fs_ of fn.foreignSchemas) {
        foreignSchemas.add(fs_.schema);
        findings.push(
          finding('warning', 'FOREIGN_SCHEMA', `${rel}: reference to schema "${fs_.schema}" left untouched.`, {
            file: rel,
            fix: 'A foreign schema cannot be stripped — it needs a synonym or an explicit decision.',
          }),
        );
      }
    } catch (err) {
      findings.push(finding('blocked', 'FUNCTION_FAILED', `${rel}: ${err.message}`, { file: rel }));
    }

    const view = generateCalcView(cv, cfg, { entityName: px.name, functionName: px.functionName, baseName: base });
    emit(targets.find((t) => t.role === 'calcview').path, view.text, 'calcview', rel);
    for (const w of view.warnings) findings.push(finding('warning', 'CALCVIEW', `${rel}: ${w}`, { file: rel }));

    const keys = [...(keysFor.get(neoId) ?? [])];
    if (!keys.length) {
      findings.push(
        finding('warning', 'NO_KEY', `${px.name} has no key column.`, {
          file: rel,
          fix: 'Checklist item 5 — every CDS entity needs a key. No .xsodata projects this view, ' +
            'so none could be derived. Add one by hand, or confirm the view is unused.',
        }),
      );
    }
    const proxy = generateProxy(cv, cfg, { entityName: px.name, keys });
    emit(targets.find((t) => t.role === 'cdsproxy').path, proxy.text, 'cdsproxy', rel);
    for (const w of proxy.warnings) findings.push(finding('warning', 'CDS_PROXY', `${rel}: ${w}`, { file: rel }));
  }

  // --- procedures: copied, with the same SQL hygiene as the functions ---
  for (const { rel, text } of procedures) {
    const target = targetsFor({ relPath: rel, kind: KIND.PROCEDURE, schema, app })[0];
    emit(target.path, text, 'procedure', rel);
  }

  // --- .xsjs / .xsjslib: one handler each, always emitted ---
  //
  // A partially converted handler is the point: the parts the tool could not
  // decide are left exactly as NEO wrote them with the reason directly above,
  // so the file is a starting point rather than a blank. The one thing not
  // emitted is a file that no longer parses — that is worse than no file.
  /** emitted handler path -> the function names it exports */
  const handlerExports = new Map();
  const sdkUsers = [];

  for (const { rel, text } of libraries) {
    const target = targetsFor({ relPath: rel, kind: KIND.LIBRARY, schema, app })[0];
    let out;
    try {
      out = transformFile(text, { filename: rel, relPath: rel, schema, procs, cfg, ai: opts.ai });
    } catch (err) {
      findings.push(
        finding('blocked', 'HANDLER_FAILED', `${rel}: ${err.message.split('\n')[0]}`, {
          file: rel,
          fix: 'This file was not converted. Migrate it by hand.',
        }),
      );
      continue;
    }
    for (const f of out.findings) {
      findings.push(finding(f.level, f.code, `${rel}: ${f.message}`, { file: rel, fix: f.fix }));
    }
    if (!out.loads) continue;   // already reported as OUTPUT_NOT_PARSEABLE or DUPLICATE_FUNCTION
    handlerExports.set(target.path, new Set(out.exportNames));
    if (out.needsSdk) sdkUsers.push(rel);
    emit(target.path, out.text, 'handler', rel);
  }

  // The converted handlers import a package the NEO tree never needed. Saying so
  // here costs one line and saves a "Cannot find module" on first `cds watch`.
  if (sdkUsers.length) {
    findings.push(
      finding('warning', 'DEPENDENCY_REQUIRED',
        `${sdkUsers.length} handler(s) call \`executeHttpRequest\`, which needs the "@sap-cloud-sdk/http-client" package.`,
        { fix: 'Add "@sap-cloud-sdk/http-client" to the CF project\'s package.json dependencies.' }),
    );
  }

  // --- services ---
  // A CAP service name is global while a NEO one was scoped by its folder, so
  // the names have to be settled across the whole tree before the first block
  // is rendered.
  const serviceNames = assignServiceNames(
    services.map((s) => ({
      rel: s.rel,
      base: path.basename(s.file, '.xsodata').replace(/[^A-Za-z0-9_]/g, '_'),
      dir: posix(s.neoDir || ''),
    })),
  );
  for (const [rel, n] of serviceNames) {
    if (!n.from) continue;
    findings.push(
      finding('warning', 'SERVICE_NAME_COLLISION',
        `${rel}: another folder has an .xsodata of the same name, and a CAP service name is global — this one is served at "/${n.name}", not "/${n.from}".`,
        { file: rel, fix: 'Update the callers of this endpoint, or rename the .xsodata in NEO and re-run.' }),
    );
  }

  const serviceByDir = new Map();
  for (const s of services) {
    if (!serviceByDir.has(s.neoDir)) serviceByDir.set(s.neoDir, []);
    serviceByDir.get(s.neoDir).push(s);
  }

  for (const [neoDir, group] of serviceByDir) {
    // Two `.xsodata` in one folder both map to `service.cds`. They are not in
    // conflict — a `.cds` file holds as many `service` blocks as you like, each
    // with its own path, and one `service.js` can wire the handlers for all of
    // them because every alias is a distinct hash. That is what the shipped CF
    // does with these same two folders, so merge rather than skip.
    const first = group[0];
    const targets = targetsFor({ relPath: first.rel, kind: KIND.SERVICE, schema, app });
    const cdsPath = targets.find((t) => t.role === 'servicecds').path;
    const jsPath = targets.find((t) => t.role === 'servicejs').path;

    if (group.length > 1) {
      findings.push(
        finding('warning', 'SERVICE_MERGED',
          `${neoDir}: ${group.length} .xsodata files share one folder, so they become ${group.length} service blocks in one service.cds.`,
          { fix: 'Check the generated paths are the ones the UI calls.' }),
      );
    }

    // Numeric-leading aliases must be renamed consistently in both files.
    for (const s of group) {
      for (const ent of s.parsed.entities ?? []) {
        if (startsWithDigit(ent.alias)) {
          const r = renames.resolve(ent.alias, `${neoDir}/service.cds`);
          ent.alias = r.name;
        } else {
          renames.resolve(ent.alias, `${neoDir}/service.cds`);
        }
      }
    }

    const blocks = [];
    // One `using` per proxy for the whole file, not per service block.
    const folderUsings = new Map();
    for (const s of group) {
      const serviceName = serviceNames.get(s.rel).name;
      try {
        const block = generateServiceBlock(s.parsed, cfg, {
          serviceName: startsWithDigit(serviceName) ? cfg.naming.numericLeadingPrefix + serviceName : serviceName,
          serviceDir: posix(path.dirname(cdsPath)),
          neoSource: s.rel,
          resolveProxy: (ns, entity) => {
            const hit = proxies.get(`${ns}::${entity}`);
            // The element list is what lets the emitter drop a `with(…)` column
            // the view does not actually have — a NEO defect CAP refuses to compile.
            return hit ? { name: hit.name, file: hit.file, elements: (hit.cv.viewAttributes || []).map((a) => a.id) } : null;
          },
        });
        blocks.push(block.serviceText);
        for (const [name, spec] of block.usings) folderUsings.set(name, spec);
        for (const w of block.warnings) findings.push(finding('warning', 'SERVICE_CDS', `${s.rel}: ${w}`, { file: s.rel }));
        for (const d of block.droppedColumns) {
          findings.push(
            finding('warning', 'XSODATA_COLUMN_DROPPED',
              d.reason === 'duplicate'
                ? `${s.rel}: entity "${d.alias}" lists column "${d.column}" twice in with(…); the repeat was dropped.`
                : `${s.rel}: entity "${d.alias}" lists column "${d.column}" in with(…), which the calc view does not have; it was dropped.`,
              { file: s.rel, fix: 'NEO did not check this list against the view and CAP does. Confirm the column is genuinely gone.' }),
          );
        }
        for (const u of block.unresolved) {
          findings.push(
            finding('blocked', 'PROXY_NOT_FOUND',
              `${s.rel}: entity "${u.alias}" projects ${u.namespace}::${u.entity}, which has no calc view in this tree.`,
              { file: s.rel, fix: 'The view lives in a module that has not been converted. Convert it first, or drop the entity.' }),
          );
        }
      } catch (err) {
        findings.push(finding('blocked', 'SERVICE_CDS_FAILED', `${s.rel}: ${err.message}`, { file: s.rel }));
      }
    }
    if (blocks.length) {
      const header = [...folderUsings].map(([name, spec]) => `using ${name} from '${spec}';`);
      const text = [...header, '', ...blocks].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
      emit(cdsPath, text, 'servicecds', group.map((s) => s.rel).join(', '));
    }

    // One handler file for the folder, wiring every alias in it once.
    //
    // Only entities with a `create using` reach this file — the rest are
    // read-only projections CAP serves from the model, and they live in
    // separate `service` blocks, so the same alias appearing in both files is
    // not a clash for them. Among the ones that do produce a handler, a
    // repeated alias is usually the identical binding written twice (13 of the
    // JB_JBPOSTPRTL pair's aliases are exactly that); only a repeat pointing
    // somewhere *different* would put one handler in front of another.
    const byAlias = new Map();
    for (const s of group) {
      for (const ent of (s.parsed.entities ?? []).filter((e) => e.createUsing)) {
        const prev = byAlias.get(ent.alias);
        if (!prev) { byAlias.set(ent.alias, { ent, file: s.file }); continue; }
        if (prev.ent.createUsing.raw !== ent.createUsing.raw) {
          findings.push(
            finding('blocked', 'ALIAS_COLLISION',
              `${neoDir}: alias "${ent.alias}" is served by ${prev.ent.createUsing.raw} in ${prev.file} and by ${ent.createUsing.raw} in ${s.file}, so one handler would shadow the other.`,
              { fix: 'Rename the alias in one of the .xsodata files, or split the folder.' }),
          );
        }
      }
    }
    const merged = { entities: [...byAlias.values()].map((v) => v.ent) };
    const s = first;
    try {
      const js = generateServiceJs(merged, { schema, outPath: jsPath });
      // Read it back. Handlers get this check inside `transformFile`; this file
      // is authored rather than rewritten, so nothing checked it — and a NEO
      // typo in one `create using` was enough to emit an import list that does
      // not parse, silently, for the whole service.
      try {
        parseJs(js.text, { filename: jsPath, sourceType: 'module' });
      } catch (err) {
        findings.push(
          finding('blocked', 'SERVICE_JS_NOT_PARSEABLE',
            `${jsPath}: the generated handler wiring does not parse: ${err.message.split('\n')[0]}`,
            { file: jsPath, fix: 'Report this — the generator produced invalid JavaScript.' }),
        );
      }
      emit(jsPath, js.text, 'servicejs', group.map((g) => g.rel).join(', '));
      for (const w of js.warnings) findings.push(finding('warning', 'SERVICE_JS', `${s.rel}: ${w}`, { file: s.rel }));

      // Does every function the .xsodata wires up actually exist? Checked
      // against what we just emitted, so it needs no reference tree. On both
      // corpora this catches entities pointing at a function their library
      // never declared — an entity wired to nothing, which CAP reports only
      // when the app starts.
      for (const b of js.wired ?? []) {
        const exported = handlerExports.get(b.target);
        if (exported && exported.has(b.fn)) continue;
        findings.push(
          finding('warning', 'HANDLER_EXPORT_MISSING',
            `${s.rel}: entity "${b.alias}" is served by ${b.fn}() in ${b.target}, ` +
            (exported ? 'which declares no such function.' : 'which was not emitted.'),
            {
              file: s.rel,
              fix: exported
                ? 'The .xsodata names a function the library does not have. Add it, or drop the entity.'
                : 'That library failed to convert — see its own finding. This entity has no handler until it does.',
            }),
        );
      }
    } catch (err) {
      findings.push(finding('blocked', 'SERVICE_JS_FAILED', `${s.rel}: ${err.message}`, { file: s.rel }));
    }
  }

  // The project shell. Last, because what it declares is decided by what the
  // rest of the run actually produced — the destination service only exists if
  // a destination call was converted.
  const project = generateProject({
    schema,
    app,
    needsSdk: sdkUsers.length > 0,
    foreignSchemas: [...foreignSchemas],
    servicePaths: files.filter((f) => f.role === 'servicecds').map((f) => f.path),
  });
  for (const f of project.files) emit(f.path, f.text, 'project', null);
  findings.push(...project.findings.map((f) => finding(f.level, f.code, f.message, { fix: f.fix })));

  // Cross-file `await`. Per-file conversion cannot see whether the function it
  // just made async is called from another file; this pass has every file at
  // once, so it is the only place the propagation can finish. It reads what was
  // emitted above and edits it — see emit/awaits.js.
  const awaits = propagateAwaits(files);
  if (awaits.awaited || awaits.asyncified) {
    findings.push(finding('note', 'AWAIT_PROPAGATED',
      `Added ${awaits.awaited} cross-file \`await\`(s) and made ${awaits.asyncified} more function(s) async.`,
      { fix: 'A call to an async function without await yields a Promise, which fails silently rather than throwing. Spot-check a few.' }));
  }
  for (const bad of awaits.failed) {
    findings.push(finding('blocked', 'AWAIT_PROPAGATION_FAILED',
      `${bad.file}: adding awaits produced JavaScript that does not parse (${bad.message}); the file was left as it was.`,
      { file: bad.file }));
  }

  const byRole = {};
  for (const f of files) byRole[f.role] = (byRole[f.role] || 0) + 1;

  return {
    intake,
    cfg,
    files,
    findings,
    renames: renames.table(),
    stats: {
      byRole,
      total: files.length,
      blocked: findings.filter((f) => f.level === 'blocked').length,
      warnings: findings.filter((f) => f.level === 'warning').length,
    },
  };
}
