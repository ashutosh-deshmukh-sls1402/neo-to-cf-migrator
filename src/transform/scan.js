/**
 * Read every .xsjs/.xsjslib in a NEO tree and report how much of its database
 * access the tool can convert without help.
 *
 * This exists because the answer decides how the migration is run. A tree where
 * 90% of statements resolve is a Tier 1 job with a short review list; one where
 * half the SQL is assembled at run time needs the AI tier or a person, and it is
 * better to know that before starting than three days in.
 *
 * It converts nothing and writes nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { discover } from '../core/intake.js';
import { KIND } from '../core/artifacts.js';
import { analyseDb } from './db.js';
import { transformFile } from './file.js';
import { indexFromIntake } from '../parse/procsig.js';

/**
 * Convert one file's database access and return the new source. The schema comes
 * from the tree, so a single file converts exactly as it would in a full run.
 */
export function convertFile(root, rel, opts = {}) {
  const intake = discover(root, opts);
  const source = fs.readFileSync(path.join(root, rel.replace(/\\/g, '/')), 'utf8');
  const procs = indexFromIntake(root, intake);
  return { rel, ...transformFile(source, { filename: rel, relPath: rel, schema: intake.schema, procs, cfg: opts.cfg, ai: opts.ai }) };
}

/**
 * @param {string} root
 * @param {{schema?:string, apps?:string[]}} [opts]
 */
export function scanDb(root, opts = {}) {
  const intake = discover(root, opts);
  const procs = indexFromIntake(root, intake);

  const rels = [];
  for (const u of intake.units) {
    if (u.kind !== KIND.LIBRARY) continue;
    for (const name of u.files) rels.push([u.neoDir, name].filter(Boolean).join('/'));
  }
  rels.sort();

  const files = [];
  const findings = [];
  const byGap = new Map();
  const byNote = new Map();
  const byKind = new Map();
  const byShape = new Map();
  const ai = { asked: 0, accepted: 0, declined: new Map() };
  let chainCount = 0;
  let resolvedCount = 0;

  const tally = (cs) => {
    for (const c of cs) {
      chainCount++;
      byKind.set(c.kind, (byKind.get(c.kind) || 0) + 1);
      byShape.set(c.shape, (byShape.get(c.shape) || 0) + 1);
      if (c.resolved) resolvedCount++;
      for (const g of c.gaps) {
        // A note is something true about a statement that DID convert, so it
        // does not belong in the tally of what stopped the conversion.
        const into = g.level === 'note' ? byNote : byGap;
        into.set(g.code, (into.get(g.code) || 0) + 1);
      }
    }
  };

  for (const rel of rels) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    let chains;
    try {
      ({ chains } = analyseDb(source, { filename: rel, procs, schema: intake.schema }));
    } catch (err) {
      findings.push({ level: 'blocked', code: 'PARSE_FAILED', file: rel, message: err.message.split('\n')[0], fix: err.message.split('\n').slice(1).join(' ') });
      files.push({ path: rel, parsed: false, chains: [], total: 0, resolved: 0 });
      continue;
    }

    let emitted = null;
    try {
      const out = transformFile(source, { filename: rel, relPath: rel, schema: intake.schema, procs, cfg: opts.cfg, ai: opts.ai });
      // With --ai, the chains the file was emitted from are not the ones the
      // first analysis produced. The report has to count what was emitted, or
      // the headline number would say Tier 1's answer and the file would say
      // Tier 2's.
      if (out.chains) chains = out.chains;
      for (const p of out.proposals || []) {
        ai.asked++;
        if (p.accepted) ai.accepted++;
        else ai.declined.set(p.reason || 'no answer', (ai.declined.get(p.reason || 'no answer') || 0) + 1);
      }
      // A file with no JDBC can still be rewritten — its `$.import`s become ES
      // imports, its `$.response` a `return` — so the test is simply whether the
      // text moved, not which pass moved it. `transformFile` already re-parsed
      // what it produced, so `loads` is a fact here, not another check.
      if (out.text !== source) {
        emitted = { converted: out.converted, imports: out.imports.length, entry: out.entry, duplicates: out.duplicateFunctions, loads: out.loads };
        findings.push(...out.findings.map((f) => ({ ...f, file: rel })));
      }
    } catch (err) {
      findings.push({ level: 'blocked', code: 'EMIT_FAILED', file: rel, message: err.message.split('\n')[0] });
    }

    tally(chains);
    files.push({
      path: rel,
      parsed: true,
      chains,
      emitted,
      total: chains.length,
      resolved: chains.filter((c) => c.resolved).length,
    });
  }

  const obj = (m) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
  return {
    intake,
    files,
    findings,
    stats: {
      files: files.length,
      unparsed: files.filter((f) => !f.parsed).length,
      withDb: files.filter((f) => f.total > 0).length,
      chains: chainCount,
      resolved: resolvedCount,
      imports: files.reduce((n, f) => n + (f.emitted ? f.emitted.imports || 0 : 0), 0),
      emitted: files.filter((f) => f.emitted).length,
      loads: files.filter((f) => f.emitted && f.emitted.loads).length,
      entries: files.filter((f) => f.emitted && f.emitted.entry).length,
      ai: { asked: ai.asked, accepted: ai.accepted, declined: obj(ai.declined) },
      byGap: obj(byGap),
      byNote: obj(byNote),
      byKind: obj(byKind),
      byShape: obj(byShape),
    },
  };
}
