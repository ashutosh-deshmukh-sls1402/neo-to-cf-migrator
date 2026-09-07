/**
 * Tier 2 — the model fills the holes Tier 1 refused, and nothing else.
 *
 * The shape of this file is the whole design (CONVERSION-STRATEGY.md §5):
 *
 *     analyse  →  ask about what was refused  →  ANALYSE AGAIN  →  emit
 *
 * The second analysis is the load-bearing step. The model's answer is fed back
 * in as an *input to Tier 1*, and Tier 1 then decides, exactly as it decides
 * everything else, whether the statement converts. So a model answer cannot
 * bypass a single existing check: bind counts, column names, OUT parameters,
 * cursor shape and the row-scope rule all still have to pass. If the statement
 * still does not resolve, the answer is discarded and the original refusal —
 * with its original wording — is what the developer sees.
 *
 * That is why this can be pointed at a 7B local model without fear. The worst a
 * bad answer can do is waste a call.
 */

import { analyseDb } from '../transform/db.js';
import { TASKS } from './tasks.js';

/**
 * @param {object[]} chains          from the first analyseDb
 * @param {object} ctx               { source, ast, opts }
 * @param {{name:string, ask:Function}} backend
 * @returns {{chains:object[], proposals:object[]}}
 */
export function aiRepair(chains, ctx, backend) {
  const { source, ast, opts } = ctx;
  const proposals = [];
  const holeKinds = new Map();   // create-node offset -> ['value', 'identifier', …]

  for (const chain of chains) {
    if (chain.resolved) continue;
    const task = TASKS.find((t) => t.applies(chain));
    if (!task) continue;

    const p = { task: task.name, file: opts.filename, sql: chain.sql.text, accepted: false, reason: null };
    proposals.push(p);

    // One retry, with the reason the first answer was rejected attached. Two
    // failures is Tier 3 — a human — which is where this statement already was.
    let prompt = task.prompt(chain, ctx);
    let verdict = null;
    for (let attempt = 0; attempt < 2 && !verdict?.kinds; attempt++) {
      let raw;
      try {
        raw = backend.ask(prompt);
      } catch (err) {
        p.reason = `the model could not be reached: ${err.message}`;
        break;
      }
      verdict = task.validate(task.parse(raw), chain);
      if (verdict.reject) {
        p.reason = verdict.reject;
        prompt = `${prompt}\n\nYour previous answer was rejected: ${verdict.reject}\nAnswer again, JSON only.`;
      }
    }
    if (!verdict?.kinds) continue;

    // `unknown` for every hole is a refusal the model agreed with. Recording it
    // matters: it is the difference between "the model declined" and "the model
    // was never asked", and only one of those is worth asking again.
    if (verdict.kinds.every((k) => k === 'unknown')) {
      p.reason = 'the model answered `unknown` for every hole';
      continue;
    }
    p.kinds = verdict.kinds;
    holeKinds.set(chain.nodes.create.start, verdict.kinds);
  }

  if (!holeKinds.size) return { chains, proposals };

  // Tier 1 again, with the answers as input. Same source, same AST, same rules.
  const second = analyseDb(source, {
    filename: opts.filename, program: ast, procs: opts.procs, schema: opts.schema, holeKinds,
  });

  // Chain order is a walk of one AST, so it is stable between the two runs. If
  // it ever is not, keep the first run: a mismatched pairing would attach one
  // statement's answer to another's SQL, which is worse than not converting.
  if (second.chains.length !== chains.length) {
    for (const p of proposals) if (!p.accepted) p.reason = 'the re-analysis did not line up with the first';
    return { chains, proposals };
  }

  const merged = chains.map((first, i) => {
    const repaired = second.chains[i];
    if (!holeKinds.has(first.nodes.create.start)) return first;
    const p = proposals.find((x) => x.sql === first.sql.text && x.kinds);
    if (repaired.resolved) {
      if (p) { p.accepted = true; p.reason = null; }
      return repaired;
    }
    // Tier 1 looked at the model's answer and still refused. That refusal is the
    // honest one, so the original chain — and its original wording — is kept.
    if (p) p.reason = `Tier 1 still refused it: ${repaired.gaps.filter((g) => g.level !== 'note').map((g) => g.code).join(', ')}`;
    return first;
  });

  return { chains: merged, proposals };
}
