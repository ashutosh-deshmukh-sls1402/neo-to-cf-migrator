/**
 * The JavaScript substrate every Tier 1 transform sits on.
 *
 * Three things and nothing else: parse, walk, splice.
 *
 * The important decision is the third one. We do NOT regenerate source from the
 * AST. We use the AST only to *locate* things, then edit the original text by
 * character offset. Regeneration would reprint all 88 files in whatever style
 * the printer likes and throw away every comment; a developer reading the output
 * beside the NEO original would lose their bearings immediately. Splicing keeps
 * every byte we did not deliberately change.
 *
 * XSJS is ES5 plus the `$` global, so it parses cleanly — the only concessions
 * are top-level `return` (XSJS files do it) and `allowHashBang`.
 */

import { parse as acornParse } from 'acorn';

/**
 * @param {string} source
 * @returns {object} an ESTree Program with `start`/`end` offsets on every node
 * @throws {Error} with the line and column, phrased for the person who has to fix it
 */
export function parse(source, { filename = '<source>', sourceType = 'script' } = {}) {
  try {
    return acornParse(source, {
      ecmaVersion: 'latest',
      sourceType,
      locations: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
      preserveParens: false,
    });
  } catch (err) {
    const at = err.loc ? ` at line ${err.loc.line}, column ${err.loc.column + 1}` : '';
    throw new Error(
      `${filename} is not parseable JavaScript${at}: ${err.message.replace(/\s*\(\d+:\d+\)$/, '')}\n` +
        `This file cannot be converted automatically. Check it opens in an editor without syntax errors.`,
    );
  }
}

const isNode = (v) => v !== null && typeof v === 'object' && typeof v.type === 'string' && typeof v.start === 'number';

/**
 * Pre-order walk. `visit(node, parent)` returning `false` skips that node's
 * children. Generic over node keys, so it needs no table of node types to
 * maintain as the ECMAScript grammar grows.
 */
export function walk(root, visit, parent = null) {
  if (visit(root, parent) === false) return;
  for (const key of Object.keys(root)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const val = root[key];
    if (Array.isArray(val)) {
      for (const v of val) if (isNode(v)) walk(v, visit, root);
    } else if (isNode(val)) {
      walk(val, visit, root);
    }
  }
}

/** Every node mapped to its parent, for walking back up. */
export function parentMap(program) {
  const parents = new Map();
  walk(program, (node, parent) => { parents.set(node, parent); });
  return parents;
}

/** The nearest enclosing function node, or the Program itself for top-level code. */
export function enclosingFunction(node, parents) {
  for (let n = parents.get(node); n; n = parents.get(n)) {
    if (/Function(Declaration|Expression)$/.test(n.type) || n.type === 'ArrowFunctionExpression' || n.type === 'Program') return n;
  }
  return null;
}

/**
 * Apply `{start, end, text}` edits to `source`.
 *
 * Overlaps are an error, not a last-write-wins: two transforms both claiming the
 * same bytes means one of them misread the code, and silently dropping either
 * one produces output that looks plausible and is wrong.
 */
export function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let cursor = 0;
  let previous = null;
  for (const e of sorted) {
    if (e.start < cursor) {
      // Both edits, not just the offsets: an overlap is always two passes
      // disagreeing, and which two is the whole question.
      const show = (x) => `[${x.start},${x.end}] "${(x.text || '').replace(/\n/g, '\\n').slice(0, 60)}" over "${source.slice(x.start, x.end).replace(/\n/g, '\\n').slice(0, 60)}"`;
      throw new Error(
        `Overlapping edits at offset ${e.start} (previous edit ran to ${cursor}). ` +
          `Two transforms claimed the same source range; this is a bug in the transform, not in the input.\n` +
          `  first:  ${previous ? show(previous) : '(none)'}\n  second: ${show(e)}`,
      );
    }
    previous = e;
    out += source.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + source.slice(cursor);
}
