/**
 * PORTED from migration-cleanup-toolkit/src/generator/hdbfunction.js (CJS -> ESM).
 * Its logic is validated against a 587-view corpus; do not "improve" it without
 * re-running score against the reference tree.
 *
 * Generate a CF `.hdbfunction` from a NEO calc view's embedded SQLScript.
 *
 * DECISIONS.md §1: the assistant's own function output is not the base text. It
 * silently rewrites SQL that exists verbatim in NEO (column substitution, injected
 * filters, case corruption). Authoring from NEO makes that whole class impossible
 * rather than detectable.
 *
 * Transform chain, in order:
 *   1. strip configured schema qualifiers  (foreign ones are left alone + reported)
 *   2. SESSION_USER -> SESSION_CONTEXT('APPLICATIONUSER')
 *   3. uppercase parameter references
 *   4. append the return statement NEO's script does not have
 *   5. wrap in the FUNCTION signature built from viewAttributes + localVariables
 *
 * Every step runs through the segment scanner, never a blind regex over raw SQL.
 */

import { renderColumnType, renderParameter } from '../parse/calcview.js';
import {
  stripSchemaQualifiers, findSchemaQualifiers, replaceInCode, scan, KIND,
  quoteReservedAliases,
} from '../parse/sqlscript.js';

/**
 * NEO's standard trailing marker. Removing it along with the END matches what the
 * hand-cleaned corpus does, so the common path stays byte-faithful to precedent.
 */
const END_MARKER = /END\s*\/\*+\s*End Procedure Script\s*\*+\/\s*$/;

/**
 * Fallback for the marker variants NEO actually contains — an `END;` followed by
 * the comment rather than preceding it, a differently-worded marker
 * ("End Optimized Procedure Script"), or a corrupted one. Finds the last END in
 * executable code and inserts before it, leaving any trailing comment in place.
 *
 * Segment-aware so an `END` inside a string literal or comment can never be
 * mistaken for the closing one.
 */
function insertReturnBeforeFinalEnd(body, returnStmt) {
  const segs = scan(body);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (s.kind !== KIND.CODE || !s.text.trim()) continue;   // skip trailing comments/blanks
    const m = /\bEND\s*;?\s*$/i.exec(s.text);
    if (!m) return null;                                     // last real code isn't an END
    segs[i] = {
      ...s,
      text: s.text.slice(0, m.index) + `${returnStmt}\nEND;` + s.text.slice(m.index + m[0].length),
    };
    return segs.map((x) => x.text).join('');
  }
  return null;
}

/**
 * Does the result variable get assigned on every path?
 *
 * A HANA table function must assign its return variable on all paths. Assignment
 * only inside IF branches is a compile risk. Assignment before the IF block is NOT
 * — that is the common "refine progressively" idiom, and treating it as a risk
 * produced a 20x false-positive rate when first measured (DECISIONS.md §9).
 */
function analyzeReturnPaths(sql, resultVar = 'var_out') {
  const assign = new RegExp(`\\b${resultVar}\\s*=`, 'i');
  let depth = 0, atTop = false, inIf = false;

  const note = (text, d) => {
    if (!assign.test(text)) return;
    if (d === 0) atTop = true; else inIf = true;
  };

  for (const seg of scan(sql)) {
    if (seg.kind !== KIND.CODE) continue;
    for (const line of seg.text.split('\n')) {
      const l = line.trim();

      if (/^END\s+IF\s*;?/i.test(l)) { depth = Math.max(0, depth - 1); continue; }

      // `IF <cond> THEN <stmt>` on one line: the statement after THEN is already
      // inside the branch, so raise the depth before attributing the assignment.
      const opener = /^IF\b(.*?)\bTHEN\b(.*)$/i.exec(l);
      if (opener) { depth++; note(opener[2], depth); continue; }

      // ELSEIF/ELSE stay at the current depth; their trailing statement is in-branch.
      const cont = /^(?:ELSEIF\b.*?\bTHEN\b|ELSE\b)(.*)$/i.exec(l);
      if (cont) { note(cont[1], Math.max(depth, 1)); continue; }

      note(l, depth);
    }
  }
  return {
    assignedAtTopLevel: atTop,
    assignedInsideIfOnly: inIf && !atTop,
    assignedAnywhere: atTop || inIf,
  };
}

/**
 * @param {object} cv         parsed calc view (see parsers/calcview.js)
 * @param {object} cfg        project config
 * @param {object} opts
 * @param {string} opts.containerPath        e.g. ICBC_JBD_..._VIEWS
 * @param {string} [opts.functionBaseName]   defaults to the calc view's FILENAME base
 * @returns {{text:string, functionName:string, transforms:object, warnings:string[], foreignSchemas:object[], returnPaths:object}}
 */
function generateFunction(cv, cfg, opts = {}) {
  if (!cv.script) {
    throw new Error(`Calc view has no embedded <definition> script: ${cv.filePath ?? cv.baseName}`);
  }

  const gen = cfg.generator || {};
  const resultVar = gen.resultVariable || 'var_out';
  const warnings = [];
  const transforms = {};

  // Identity: filename wins, never NEO's internal scenario id (DECISIONS.md §5).
  const baseName = opts.functionBaseName ?? cv.baseName;
  if (!baseName) throw new Error('generateFunction needs a functionBaseName or a calc view with a filePath');
  const prefix = (cfg.naming?.functionFilePrefix ?? 'TABLE_FUNCTION_');
  const functionName = `${opts.containerPath}_${prefix}${baseName}`.toUpperCase();

  let body = cv.script;

  // 1. schema qualifiers — configured ones stripped, foreign ones reported untouched.
  const foreignSchemas = findSchemaQualifiers(body).filter(
    (q) => !(cfg.schemas?.strippable ?? []).some((s) => s.toUpperCase() === String(q.schema).toUpperCase())
  );
  const strip = stripSchemaQualifiers(body, cfg.schemas?.strippable ?? []);
  body = strip.sql;
  transforms.schemasStripped = strip.stripped.length;

  // 2. SESSION_USER is wrong under CF: the DB connects as a technical user.
  const replacement = gen.sessionUserReplacement || "SESSION_CONTEXT('APPLICATIONUSER')";
  const su = replaceInCode(body, /\bSESSION_USER\b/g, replacement);
  body = su.sql;
  transforms.sessionUserReplaced = su.count;

  // 3. parameter references (HANA folds unquoted identifiers, so this is for
  //    consistency with the declared signature, not resolution).
  transforms.parametersUppercased = 0;
  if (cfg.naming?.uppercaseParameters !== false) {
    for (const p of cv.parameters) {
      if (!p.id || p.id === p.id.toUpperCase()) continue;
      const re = new RegExp(`(:?)\\b${p.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      const r = replaceInCode(body, re, (_m, colon) => `${colon}${p.id.toUpperCase()}`);
      body = r.sql;
      transforms.parametersUppercased += r.count;
    }
  }

  // 3b. Reserved-word aliases. NEO writes `AS COUNT` / `AS VALUE` / `AS TYPE` bare,
  //     which HANA rejects or folds unexpectedly. Generating faithfully from NEO would
  //     otherwise reproduce a NEO-side defect — confirmed against hand-authored output,
  //     where 5 of 20 functions differed by exactly this.
  const reserved = cfg.sqlHygiene?.reservedWords;
  const qa = quoteReservedAliases(body, reserved && reserved.length ? reserved : undefined);
  body = qa.sql;
  transforms.reservedAliasesQuoted = qa.quoted.length;
  if (qa.quoted.length) transforms.reservedAliasList = [...new Set(qa.quoted)];

  // 4. NEO scripts never carry a return statement (0 of 546). Append one.
  const returnStmt = gen.returnStatement || `return :${resultVar};`;
  if (END_MARKER.test(body)) {
    body = body.replace(END_MARKER, `${returnStmt}\nEND;`);
    transforms.returnAppended = true;
  } else {
    const patched = insertReturnBeforeFinalEnd(body, returnStmt);
    if (patched) {
      body = patched;
      transforms.returnAppended = true;
      warnings.push(
        'Script did not carry NEO\'s standard "End Procedure Script" marker; the return ' +
        'statement was inserted before the final END instead, and any trailing comment kept. ' +
        'Verify the result.'
      );
    } else {
      transforms.returnAppended = false;
      warnings.push(
        `Could not locate a trailing END to insert "${returnStmt}" before. ` +
        'The generated function would not compile without a return statement.'
      );
    }
  }

  // 5. signature
  const returnPaths = analyzeReturnPaths(cv.script, resultVar);
  if (!returnPaths.assignedAnywhere) {
    warnings.push(`Result variable "${resultVar}" is never assigned in this script.`);
  }

  const cols = cv.viewAttributes.map((a) => `"${a.id}" ${renderColumnType(a)}`).join(', ');
  if (!cols) warnings.push('No viewAttributes found — RETURNS TABLE would be empty.');

  const params = cv.parameters
    .map((p) => renderParameter(p, { uppercase: cfg.naming?.uppercaseParameters !== false }))
    .join(', ');

  const text =
    `FUNCTION "${functionName}" (${params})\n` +
    `RETURNS TABLE (${cols})\n` +
    `LANGUAGE SQLSCRIPT\n` +
    `SQL SECURITY DEFINER\n` +
    `  AS \n\n` +
    body;

  return { text, functionName, transforms, warnings, foreignSchemas, returnPaths };
}

export { generateFunction, analyzeReturnPaths };
