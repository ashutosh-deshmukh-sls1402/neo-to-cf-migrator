/**
 * `.hdbprocedure` — the same SQL hygiene the table functions get.
 *
 * A NEO procedure is written against a classic HANA schema it names out loud:
 *
 *     PROCEDURE "ARBDR"."ARBDR.RSM.Inbound.Procedures::prCreateUpdateLMSMasterdata" (…)
 *        DEFAULT SCHEMA ARBDR
 *     AS BEGIN
 *        SELECT COUNT(1) INTO CNT FROM "ARBDR"."RSM_M_LMSDT" …
 *
 * None of that survives the move. Under HDI the objects live in a container
 * schema whose name is generated at deploy time, so every one of those three
 * references — the declared name, the `DEFAULT SCHEMA` clause, and each
 * qualified table — resolves to a schema that is not there.
 *
 *     PROCEDURE "ARBDR_RSM_INBOUND_PROCEDURES_PRCREATEUPDATELMSMASTERDATA" (…)
 *     AS BEGIN
 *        SELECT COUNT(1) INTO CNT FROM "RSM_M_LMSDT" …
 *
 * The declared name is flattened by the same rule as every other HANA object in
 * the tree (`flattenEntityName`), which is what makes the handler's
 * `cds.run('CALL ARBDR_RSM_Inbound_Procedures_prCreateUpdateLMSMasterdata(?)')`
 * find it: that call is unquoted, so HANA folds it to upper case, and this name
 * is the folded form. Emitting the declaration in its original mixed case would
 * store a name the unquoted call can never resolve.
 *
 * Everything here goes through the segment scanner, never a raw regex — a `--`
 * comment quoting an old table name is left exactly as it was, which is why the
 * corpus still shows schema-qualified names inside comments after this runs.
 */

import {
  scan, render, identName, KIND,
  stripSchemaQualifiers, findSchemaQualifiers, replaceInCode,
} from '../parse/sqlscript.js';
import { flattenEntityName } from '../core/naming.js';

/** `PROCEDURE`/`CALL` followed by `"name"` or `"schema"."name"`, in code only. */
function flattenAfterKeyword(text, keyword, renderName) {
  const word = new RegExp(`\\b${keyword}\\s*$`, 'i');
  const segs = scan(text);
  const out = [];
  const names = [];

  for (let n = 0; n < segs.length; n++) {
    const s = segs[n];
    out.push(s);
    if (s.kind !== KIND.CODE || !word.test(s.text)) continue;

    const first = segs[n + 1];
    if (!first || first.kind !== KIND.QUOTED_IDENT) continue;

    // `"SCHEMA"."ns::name"` — the schema goes with the flattening, because the
    // repository path already carries it as its first segment.
    const dot = segs[n + 2];
    const second = segs[n + 3];
    const qualified =
      dot && dot.kind === KIND.CODE && /^\.\s*$/.test(dot.text) && second && second.kind === KIND.QUOTED_IDENT
        ? { name: identName(second), span: 3 }
        : { name: identName(first), span: 1 };

    // Only a NEO repository path. `CALL SYS.X(?)` and an already-flat name are
    // real names, not paths, and are left alone.
    if (!qualified.name || !qualified.name.includes('::')) continue;

    const flat = flattenEntityName(qualified.name);
    names.push({ from: qualified.name, to: flat });
    out.push(renderName(flat));
    n += qualified.span;
  }

  return { text: render(out), names };
}

/**
 * Drop `DEFAULT SCHEMA <name>`, quoted or not.
 *
 * The clause decides where unqualified names resolve. In an HDI container that
 * is the container's own schema and saying otherwise breaks every unqualified
 * reference in the body — so it goes, but only when it names a schema this
 * project owns. Pointing at somebody else's schema is a decision, not a typo.
 */
function dropDefaultSchema(text, strippable) {
  const wanted = new Set((strippable || []).map((s) => s.toUpperCase()));
  const segs = scan(text);
  const out = [];
  const dropped = [];
  const kept = [];

  for (let n = 0; n < segs.length; n++) {
    const s = segs[n];
    // `DEFAULT SCHEMA "ARBDR"` — the name is its own segment.
    const quoted = s.kind === KIND.CODE && /\bDEFAULT\s+SCHEMA\s*$/i.test(s.text);
    const next = segs[n + 1];
    if (quoted && next && next.kind === KIND.QUOTED_IDENT) {
      const name = identName(next);
      if (!wanted.has(String(name).toUpperCase())) { kept.push(name); out.push(s); continue; }
      dropped.push(name);
      out.push({ ...s, text: s.text.replace(/[^\S\n]*\bDEFAULT\s+SCHEMA\s*$/i, '') });
      n += 1;
      // The clause owned its line; take the newline that ended it too.
      const after = segs[n + 1];
      if (after && after.kind === KIND.CODE) {
        segs[n + 1] = { ...after, text: after.text.replace(/^[^\S\n]*\n/, '') };
      }
      continue;
    }

    if (s.kind !== KIND.CODE) { out.push(s); continue; }
    // `DEFAULT SCHEMA ARBDR` — all one code segment, so the whole line goes.
    const text_ = s.text.replace(/[^\S\n]*\bDEFAULT\s+SCHEMA\s+([A-Za-z_]\w*)[^\S\n]*\n?/gi, (m, name) => {
      if (!wanted.has(name.toUpperCase())) { kept.push(name); return m; }
      dropped.push(name);
      return '';
    });
    out.push({ ...s, text: text_ });
  }

  return { text: render(out), dropped, kept };
}

/**
 * @param {string} source  the `.hdbprocedure` verbatim
 * @param {object} cfg     resolved config
 * @returns {{text:string, name:string|null, transforms:object,
 *            warnings:{level:string,code:string,message:string,fix?:string}[],
 *            foreignSchemas:string[]}}
 */
export function generateProcedure(source, cfg = {}) {
  const strippable = cfg.schemas?.strippable ?? [];
  const warnings = [];
  const transforms = {};
  let text = source;

  // 1. The declared name, first — flattening it removes the `"SCHEMA".` in front
  //    of it as well, so the strip below sees a body with no header noise in it.
  const decl = flattenAfterKeyword(text, 'PROCEDURE', (flat) => ({ kind: KIND.QUOTED_IDENT, text: `"${flat}"` }));
  text = decl.text;
  const name = decl.names[0]?.to ?? null;
  if (!name) {
    warnings.push({
      level: 'warning',
      code: 'PROCEDURE_NAME_UNCHANGED',
      message: 'The declared procedure name is not a NEO repository path, so it was left as it is.',
      fix: 'A handler calls this by its flattened name. Check the declaration matches what `cds.run(\'CALL …\')` asks for.',
    });
  }
  transforms.nameFlattened = decl.names[0] ?? null;

  // 2. Nested calls to other NEO procedures, by the same rule, so the two agree.
  const calls = flattenAfterKeyword(text, 'CALL', (flat) => ({ kind: KIND.CODE, text: flat }));
  text = calls.text;
  transforms.callsFlattened = calls.names.length;

  // 3. `DEFAULT SCHEMA`.
  const ds = dropDefaultSchema(text, strippable);
  text = ds.text;
  transforms.defaultSchemaDropped = ds.dropped.length;
  for (const s of new Set(ds.kept)) {
    warnings.push({
      level: 'warning',
      code: 'DEFAULT_SCHEMA_FOREIGN',
      message: `\`DEFAULT SCHEMA ${s}\` names a schema this project does not own, so it was left in place.`,
      fix: `Unqualified names in this procedure resolve in ${s}. Decide whether the HDI container needs a synonym, or drop the clause by hand.`,
    });
  }

  // 4. Qualified tables — ours stripped, anyone else's reported untouched.
  const foreign = [...new Set(
    findSchemaQualifiers(text)
      .filter((q) => !strippable.some((s) => s.toUpperCase() === String(q.schema).toUpperCase()))
      .map((q) => q.schema),
  )];
  const strip = stripSchemaQualifiers(text, strippable);
  text = strip.sql;
  transforms.schemasStripped = strip.stripped.length;

  // 5. SESSION_USER is wrong under CF: the database connects as a technical user.
  const su = replaceInCode(text, /\bSESSION_USER\b/g,
    cfg.generator?.sessionUserReplacement || "SESSION_CONTEXT('APPLICATIONUSER')");
  text = su.sql;
  transforms.sessionUserReplaced = su.count;

  return { text, name, transforms, warnings, foreignSchemas: foreign };
}
