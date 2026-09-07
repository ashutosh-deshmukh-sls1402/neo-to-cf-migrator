/**
 * How a model is reached. One function, one string in, one string out.
 *
 * Everything about the AI tier that is *not* this file is deterministic, and
 * that is the point: the backend is the only place with a subprocess, a network
 * hop, or any non-determinism at all. Swapping Claude for a local model is a
 * different `--ai` value and nothing else — D3.
 *
 * The call is **synchronous**. The whole pipeline is synchronous — one parse,
 * one set of edits, one splice — and making it async to save wall-clock on at
 * most a few dozen calls per run would be a rewrite paid for with nothing.
 *
 *   --ai none              the default. Tier 1 only; holes get NEEDS HUMAN REVIEW
 *   --ai claude            `claude -p` — the cloud model, for proving the plumbing
 *   --ai cmd:<command>     anything that reads a prompt on stdin and writes to
 *                          stdout, which is every local runner:
 *                            --ai "cmd:ollama run qwen2.5-coder:7b"
 */

import { spawnSync } from 'node:child_process';

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 1 << 20;

/** Run a command with the prompt on stdin; return stdout, or throw. */
function runCommand(cmd, args, prompt, { shell = false } = {}) {
  const r = spawnSync(cmd, args, {
    input: prompt,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    shell,
  });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${cmd} exited ${r.status}: ${String(r.stderr || '').trim().slice(0, 300)}`);
  }
  return String(r.stdout || '');
}

/**
 * @param {string|Function|null|undefined} spec
 * @returns {{name:string, ask:(prompt:string)=>string}|null} null for no-AI mode
 */
export function resolveBackend(spec) {
  if (!spec || spec === 'none' || spec === true) return null;

  // A function is what the tests pass. No subprocess, no network, and every
  // validator can be exercised against a canned answer.
  if (typeof spec === 'function') return { name: 'inline', ask: spec };

  if (spec === 'claude') {
    return {
      name: 'claude',
      // The prompt goes on stdin, not argv: prompts are kilobytes and Windows
      // has a command-line length limit that would truncate them silently.
      ask: (prompt) => runCommand('claude', ['-p'], prompt, { shell: process.platform === 'win32' }),
    };
  }

  if (typeof spec === 'string' && spec.startsWith('cmd:')) {
    const command = spec.slice(4).trim();
    if (!command) throw new Error('--ai cmd: needs a command, e.g. --ai "cmd:ollama run qwen2.5-coder"');
    return { name: command, ask: (prompt) => runCommand(command, [], prompt, { shell: true }) };
  }

  throw new Error(`Unknown --ai backend "${spec}". Use none, claude, or cmd:<command>.`);
}
