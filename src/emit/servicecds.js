/**
 * PORTED from migration-cleanup-toolkit/src/generator/servicecds.js (CJS -> ESM).
 * Measured fully deterministic against the shipped corpus, which is why the
 * toolkit's AI tier refuses this artifact. Do not route it to a model.
 */
/**
 * `service.cds` authoring — CAP service definition from the NEO `.xsodata`.
 *
 * This is step 6a, and it exists because of a measurement rather than an assumption.
 * The AI tier's first candidate task was reconstructing the `service.cds` that the
 * migration assistant emits as an empty stub. Mapping a shipped service back to its
 * `.xsodata` line by line showed every construct has a mechanical source:
 *
 *   using … from '…'                        entity namespace -> proxy name + path
 *   service X @(path:'/X')                  .xsodata filename (+ role suffix)
 *   entity A as projection on P             entity + alias
 *   entity A(P:T) as projection on X(P::P)  entity + alias + the calc view's own parameter(s)
 *   @readonly                               create/update/delete forbidden
 *   association to many B on B.C = $self.C  navigates(...) + association principal/dependent
 *   action A(PAYLOAD : LargeString)         create using
 *
 * So it is a rule, not a prompt. `src/ai/triage.js` classifies this finding as
 * `deterministic` and refuses to send it to a model.
 *
 * One deliberate asymmetry: an entity carrying `create using` becomes an **action only**
 * — no projection and no `using` for it. That is what the hand-migrated services do,
 * because the endpoint is a write path, not a readable set.
 */

import path from 'node:path';
import { cdsIdent } from '../core/naming.js';
import { cdsType, DEFAULT_TYPE_MAP } from './cdsproxy.js';

/**
 * Service names, exactly as NEO named them.
 *
 * A NEO service is identified by its *path* — two folders may hold an
 * `EMP_JBPOSTPRTL_gp88h82pwzbf0p47.xsodata` each and nothing collides there. A
 * CAP service name is global, so on paper that is a `Duplicate definition of
 * artifact` once both are deployed. This used to "fix" that by prefixing every
 * colliding name with a folder segment — which silently changed the OData path
 * (`/EMP_…` became `/RSM_EMP_…`) for a name a UI, a destination, or a test
 * script already calls by its NEO spelling. That is not this tool's contract
 * to renegotiate, and a prefix nobody asked for breaks callers just as surely
 * as a compile error does — more so, because a compile error is loud.
 *
 * So the name is always exactly the NEO filename. A collision is reported
 * (`SERVICE_NAME_COLLISION`, convert.js) and left as it is — the developer
 * decides which one wins, or renames one `.xsodata` in NEO and re-runs.
 *
 * @param {{rel:string, base:string}[]} services
 * @returns {Map<string, {name:string, collidesWith:string[]}>} keyed by `rel`
 */
export function assignServiceNames(services) {
  const byBase = new Map();
  for (const s of services) {
    if (!byBase.has(s.base)) byBase.set(s.base, []);
    byBase.get(s.base).push(s.rel);
  }

  const out = new Map();
  for (const s of services) {
    const group = byBase.get(s.base);
    out.set(s.rel, { name: s.base, collidesWith: group.length > 1 ? group.filter((r) => r !== s.rel) : [] });
  }
  return out;
}

/** CDS wants a relative specifier; a bare name would be read as a module. */
function relSpecifier(fromDir, toFile) {
  const rel = path.relative(fromDir, toFile).replace(/\\/g, '/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Render one navigation as a CAP association.
 *
 *   navigates("BidNotes_Attachment" as "jAdquJwLnJJCalgb")
 *   + association "BidNotes_Attachment"
 *       principal "bjAdquJwLnJJCalg"("SUMID") multiplicity "1"
 *       dependent "wLnJJCalgbjAdquJ"("SUMID") multiplicity "*"
 *   -> jAdquJwLnJJCalgb: association to many wLnJJCalgbjAdquJ
 *        on jAdquJwLnJJCalgb.SUMID = $self.SUMID
 *
 * Three separate names are in play and they are easy to confuse:
 *
 *   - the `as` alias in `navigates` is the NAVIGATION PROPERTY name
 *   - the TARGET entity is the association's DEPENDENT alias — never the navigates alias
 *   - the association name itself only joins the two declarations together
 *
 * In most sections the navigates alias and the dependent alias happen to be the same
 * string, so using one for the other looks correct everywhere except the one section
 * where the author chose differently. That section is the reason this is spelled out.
 *
 * The left-hand column comes from the DEPENDENT side and the `$self` column from the
 * PRINCIPAL side — again frequently the same name, and again silent when reversed.
 *
 * ── On the navigation property name ─────────────────────────────────────────
 * The corpus is split down the middle. Three shipped sections name the property after
 * the `navigates` alias, three after the association name:
 *
 *     zy9paqw922n9wvxu: association to many zy9paqw922n9wvxu        (3 sections)
 *     empLc_LocationPreference: association to many lgbjAdquJwLnJJcA (3 sections)
 *
 * XS OData reads `navigates("assoc" as "navProp")` as binding the association to a
 * navigation property *named by the alias*, so the alias is the spec-correct default.
 * But this name is what a UI puts in `$expand=`, and a wrong one fails at runtime with
 * no build error — so the caller is also handed a note to that effect, and
 * `serviceGenerate.associationNaming` can switch it per project.
 */
function renderAssociation(nav, assoc, warnings, naming = 'navigation-alias') {
  if (!assoc) {
    warnings.push(`navigates("${nav.association}") has no matching association definition — skipped.`);
    return null;
  }
  const dep = assoc.dependent || {};
  const pri = assoc.principal || {};
  const depCols = dep.columns || [];
  const priCols = pri.columns || [];

  if (!depCols.length || depCols.length !== priCols.length) {
    warnings.push(
      `Association "${assoc.name}" has ${priCols.length} principal column(s) and ` +
      `${depCols.length} dependent column(s) — cannot build an ON condition.`
    );
    return null;
  }

  if (!dep.alias) {
    warnings.push(`Association "${assoc.name}" declares no dependent alias — no target to point at.`);
    return null;
  }

  const cardinality = String(dep.multiplicity || '*').includes('*') ? 'to many' : 'to one';
  const propName = naming === 'association-name' ? nav.association : nav.target;
  const on = depCols
    .map((c, i) => `${propName}.${c} = $self.${priCols[i]}`)
    .join(' and ');

  // Target is the DEPENDENT alias, not the navigates alias. See the note above.
  return `${propName}: association ${cardinality} ${dep.alias} on ${on}`;
}

/**
 * A projection over a parameterised calc view repeats the whole parameter list
 * twice — CAP has no shorthand for "same as the thing I project on":
 *
 *   entity svxuac4g3i7dhzl4(pTABID: Integer)
 *     as projection on ICBC_ADMIN_VIEWS_ADM_TLWMASTERDATA(pTABID: :pTABID);
 *
 * `.xsodata` never spells the parameter's type — HANA's `parameters via key and
 * entity "…" results property "Execute"` clause names an OData Parameters
 * entity, not the parameter itself, and 185 of 546 corpus views take one that
 * clause never even mentions. The calc view's own `<variable parameter="true">`
 * is the only place a name or a type is declared, which is why this reads
 * `proxy.parameters` — the same list `cdsproxy.js` used to write the entity
 * being projected onto — rather than anything out of the `.xsodata`. Missing
 * this turns a legal HANA parameterised view into a service.cds entity CAP
 * cannot address at all: `as projection on X` with no parameter list, over an
 * `X` that requires one, fails to compile.
 *
 * @param {{id:string, datatype:string, length?, scale?}[]} parameters
 * @param {object} typeMap
 * @param {string[]} warnings   pushed into on an unmapped HANA type
 * @returns {{decl:string, pass:string}|null} null when there are none
 */
function paramSignature(parameters, typeMap, warnings) {
  if (!parameters?.length) return null;
  // Same rule as the proxy itself: NEO's own spelling, never uppercased — the
  // shipped corpus disagrees with itself on casing, so there is no precedent
  // to normalise to, and getting it wrong means the two sides of "as
  // projection on" no longer name the same parameter.
  const names = parameters.map((p) => cdsIdent(p.id));
  const decl = parameters
    .map((p) => {
      const { type, warning } = cdsType(p, typeMap);
      if (warning) warnings.push(`parameter ${warning}`);
      return `${cdsIdent(p.id)}: ${type || 'String'}`;
    })
    .join(', ');
  const pass = names.map((n) => `${n}: :${n}`).join(', ');
  return { decl, pass };
}

/**
 * @param {object} parsed        parseXsodata() result
 * @param {object} cfg           project config
 * @param {object} opts
 * @param {string} opts.serviceName    service name, already suffixed if it collides
 * @param {string} opts.serviceDir     absolute dir the service.cds will live in
 * @param {Function} opts.resolveProxy (namespace, entity) => {name, file, elements, parameters} | null
 * @param {string} [opts.neoSource]    provenance path for the header comment
 * @param {Function} [opts.payloadParam] (entity) => the column its handler reads, for the cross-check
 * @returns {{text:string, warnings:string[], stats:object, unresolved:object[]}}
 */
function generateServiceBlock(parsed, cfg, opts) {
  const warnings = [];
  const unresolved = [];
  const droppedColumns = [];
  const usings = new Map();       // proxy name -> specifier
  const body = [];
  const actions = [];
  const actionParams = [];

  const assocByName = new Map((parsed.associations || []).map((a) => [a.name, a]));
  const naming = cfg.serviceGenerate?.associationNaming || 'navigation-alias';
  let navCount = 0;
  const pc = cfg.cdsProxy || {};
  const typeMap = { ...DEFAULT_TYPE_MAP, ...(pc.typeMap || {}) };

  for (const ent of parsed.entities || []) {
    // A create-using entity is a write endpoint: action only, no projection, no using.
    if (ent.createUsing) {
      // NEO handed the exit its input through a temporary table, and `with(…)`
      // is that table's column list — which on a create-using entity is the
      // action's parameter list, not a projection. The `key(…)` column is the
      // temporary table's own key rather than an input, so it comes back out:
      //
      //     with("PAYLOAD","COL") key("COL")   ->   action X(PAYLOAD: LargeString)
      //
      // Declaring nothing, as this did before, leaves the handler reading
      // `req.data.PAYLOAD` from a request CAP never put it on.
      const keys = new Set(ent.keys || []);
      const params = (ent.with || []).filter((c) => !keys.has(c));
      // …except that 19 of ICBC's create-using entities carry no `with(…)` at
      // all, only a key, while their handler still reads a payload. The
      // .xsodata is the declaration; the handler is what actually runs, so the
      // column it reads is added when the clause does not already name it.
      const fromHandler = opts.payloadParam ? opts.payloadParam(ent) : null;
      const added = fromHandler && !params.includes(fromHandler) ? fromHandler : null;
      if (added) params.push(added);
      const type = cfg.serviceActions?.payloadType ?? 'LargeString';
      actions.push(
        `action ${ent.alias}(${params.map((p) => `${cdsIdent(p)}: ${type}`).join(', ')}) ` +
        `returns ${cfg.serviceActions?.returnType ?? 'String'};`,
      );
      // The handler is the other half of this: it reads `req.data.<column>`.
      // The caller checks the two agree — see ACTION_PAYLOAD_MISSING.
      actionParams.push({ alias: ent.alias, params, added, createUsing: ent.createUsing });
      continue;
    }

    const proxy = opts.resolveProxy(ent.namespace, ent.entity);
    if (!proxy) {
      // Never project an entity that does not exist — it would not compile. Record it
      // in the file as well as the report, so the gap is visible in the artifact.
      unresolved.push({ alias: ent.alias, namespace: ent.namespace, entity: ent.entity });
      body.push(`    // TODO: entity ${ent.alias} omitted — no CDS proxy found for ${ent.namespace}::${ent.entity}`);
      continue;
    }

    usings.set(proxy.name, relSpecifier(opts.serviceDir, proxy.file));

    const navs = (ent.navigates || [])
      .map((n) => renderAssociation(n, assocByName.get(n.association), warnings, naming))
      .filter(Boolean);
    navCount += navs.length;

    if (ent.readonly) body.push('    @readonly');

    // `with("A","B")` on a READABLE entity restricts the projection to those columns.
    // (On a create-using entity the same clause means something else entirely — the
    // action's parameter list — which is why that case returned above.)
    //
    // NEO did not check that list against the view. CAP does, and stops: 111 of
    // TECK's compile errors are `Element "BDLNT" has not been found` for columns
    // no calc view ever declared. Those are NEO defects, so the column is
    // dropped and named — the same treatment `.xsodata` keys already get.
    let selected = (ent.with || []).length ? ent.with.slice() : null;
    if (selected && proxy.elements?.length) {
      const known = new Set(proxy.elements.map((e) => String(e).toUpperCase()));
      const seen = new Set();
      const kept = [];
      for (const col of selected) {
        const up = String(col).toUpperCase();
        if (!known.has(up)) { droppedColumns.push({ alias: ent.alias, column: col, reason: 'unknown' }); continue; }
        if (seen.has(up)) { droppedColumns.push({ alias: ent.alias, column: col, reason: 'duplicate' }); continue; }
        seen.add(up);
        kept.push(col);
      }
      // Every column was bad: fall back to the full projection rather than
      // emitting `{ }`, which is not a projection at all.
      selected = kept.length ? kept : null;
    }
    // A projection carries a primary key only if it lists *every* key of the
    // entity it projects on — CAP rejects a partial key with "Expected entity to
    // have a primary key". The proxy can end up with more keys than this service
    // wants, because different `.xsodata` key the same view differently, so the
    // key is restated here from the `key(…)` this .xsodata declares.
    const keys = new Set((ent.keys || []).map((k) => String(k).toUpperCase()));
    const members = [
      ...(selected || ['*']).map((c) => (keys.has(String(c).toUpperCase()) ? `key ${cdsIdent(c)}` : cdsIdent(c))),
      ...navs,
    ];

    // A parameterised calc view has to be addressed with its parameter list on
    // BOTH sides of "as projection on" — see paramSignature above. Skipping
    // this is silent right up until `cds build`, which is the one place NEO
    // never validated it either.
    const params = paramSignature(proxy.parameters, typeMap, warnings);
    const aliasSig = params ? `(${params.decl})` : '';
    const onClause = params ? `${proxy.name}(${params.pass})` : proxy.name;

    if (selected || navs.length) {
      body.push(`    entity ${ent.alias}${aliasSig} as projection on ${onClause} {`);
      body.push(members.map((m) => `        ${m}`).join(',\n'));
      body.push('    };');
    } else {
      body.push(`    entity ${ent.alias}${aliasSig} as projection on ${onClause};`);
    }
    body.push('');
  }

  if (navCount) {
    warnings.push(
      `${navCount} association(s) named by "${naming}". This is the navigation property a UI ` +
      'puts in $expand=, the shipped corpus is split 3 sections to 3 on the convention, and a ' +
      'wrong name fails at runtime with no build error. Set serviceGenerate.associationNaming ' +
      'to "association-name" if this project uses the other one.'
    );
  }

  if (actions.length) {
    body.push('    // item 27 — NEO `create using` endpoints, restored as CAP actions');
    for (const a of actions) body.push(`    ${a}`);
  }

  const lines = [];
  if (opts.neoSource) lines.push(`//converted from: ${opts.neoSource}`);
  // Declaration order, not alphabetical: the hand-migrated services list imports in the
  // order the .xsodata declares its entities, and matching that keeps a diff against a
  // shipped service readable instead of a full-file reshuffle. (Map preserves insertion.)
  for (const [name, spec] of usings) {
    lines.push(`using ${name} from '${spec}';`);
  }
  lines.push('');
  lines.push(`service ${opts.serviceName} @(path:'/${opts.serviceName}') {`);
  lines.push(...body);
  lines.push('}');

  // `usings` and `serviceText` are returned apart from `text` because two
  // `.xsodata` in one folder become two service blocks in ONE file, and a `using`
  // may be declared only once per file — CDS rejects the repeat as a duplicate
  // top-level name. The caller merges the maps and writes the header itself.
  const serviceLines = [];
  if (opts.neoSource) serviceLines.push(`//converted from: ${opts.neoSource}`);
  serviceLines.push(`service ${opts.serviceName} @(path:'/${opts.serviceName}') {`, ...body, '}');

  return {
    text: lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n',
    usings,
    serviceText: serviceLines.join('\n').replace(/\n{3,}/g, '\n\n'),
    warnings,
    unresolved,
    droppedColumns,
    actionParams,
    stats: {
      entities: (parsed.entities || []).length,
      projected: (parsed.entities || []).length - actions.length - unresolved.length,
      actions: actions.length,
      associations: (parsed.entities || []).reduce((n, e) => n + (e.navigates || []).length, 0),
      usings: usings.size,
    },
  };
}

export { generateServiceBlock, renderAssociation, relSpecifier };
