/**
 * .calculationview parser.
 *
 * Extracts everything the three emitters need:
 *   - the scenario id and its metadata
 *   - a node inventory, to classify the view
 *   - the embedded SQLScript — the key extraction, since the table function is
 *     generated FROM it rather than repaired from the assistant's output
 *   - viewAttributes  -> the RETURNS TABLE signature and the CDS proxy columns
 *   - localVariables  -> input parameters (38% of the corpus is parameterised)
 *
 * Built on fast-xml-parser rather than regex: calc views are machine-generated
 * and regex survives them today, but an XML comment containing markup or a CDATA
 * section would silently break a hand-rolled reader, and the failure would look
 * like a missing column rather than a parse error.
 *
 * The classification and field selection below are ported from
 * migration-cleanup-toolkit, which validated them against 587 real views.
 */

import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';

export const CLASS = Object.freeze({
  /** One SqlScriptView and nothing layered on top — safe to generate from the script. */
  PURE_SCRIPT: 'PURE_SCRIPT',
  /** Script plus other nodes — generating from the script alone would lose modelling work. */
  SCRIPT_PLUS: 'SCRIPT_PLUS',
  /** No script node at all. */
  NODE_BASED: 'NODE_BASED',
  UNPARSED: 'UNPARSED',
});

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // Keep every value a string: HANA lengths and ids must not become numbers,
  // and "false"/"true" must not become booleans on the way to a template.
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: true,
  // A single <viewAttribute> and a list of them must have the same shape.
  isArray: (name) =>
    ['calculationView', 'viewAttribute', 'variable', 'DataSource', 'attribute', 'measure'].includes(name),
});

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const isScriptNode = (t) => /SqlScriptView/i.test(String(t ?? ''));

/** Depth-first search for the first element with this tag name. */
function findFirst(node, name) {
  if (node == null || typeof node !== 'object') return null;
  for (const [k, v] of Object.entries(node)) {
    if (k === name) return Array.isArray(v) ? v[0] : v;
    for (const child of arr(v)) {
      if (child && typeof child === 'object') {
        const hit = findFirst(child, name);
        if (hit != null) return hit;
      }
    }
  }
  return null;
}

/**
 * @param {string} xml
 * @param {string|null} filePath used to derive the base name and check the id
 */
export function parseCalcView(xml, filePath = null) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    return { filePath, classification: CLASS.UNPARSED, error: err.message, viewAttributes: [], parameters: [], nodes: [] };
  }

  const scenario = doc['Calculation:scenario'];
  if (!scenario) {
    return { filePath, classification: CLASS.UNPARSED, error: 'no Calculation:scenario root', viewAttributes: [], parameters: [], nodes: [] };
  }

  const nodes = arr(findFirst(scenario, 'calculationViews')?.calculationView).map((n) => ({
    id: n['@id'] ?? null,
    type: n['@xsi:type'] ?? null,
    isScript: isScriptNode(n['@xsi:type']),
  }));

  const scriptNodes = nodes.filter((n) => n.isScript);
  const otherNodes = nodes.filter((n) => !n.isScript);

  // The embedded SQLScript. fast-xml-parser puts element text under #text, but a
  // <definition> holding only text collapses to the string itself.
  const defNode = findFirst(scenario, 'definition');
  const script =
    defNode == null ? null : typeof defNode === 'string' ? defNode : (defNode['#text'] ?? null);

  const viewAttributes = arr(findFirst(scenario, 'viewAttributes')?.viewAttribute).map((a) => ({
    id: a['@id'] ?? null,
    datatype: a['@datatype'] ?? null,
    length: a['@length'] ?? null,
    scale: a['@scale'] ?? null,
  }));

  // localVariables -> input parameters. Only parameter="true" ones are inputs.
  const parameters = arr(findFirst(scenario, 'localVariables')?.variable)
    .filter((v) => String(v['@parameter']).toLowerCase() === 'true')
    .map((v) => {
      const props = v.variableProperties ?? {};
      return {
        id: v['@id'] ?? null,
        datatype: props['@datatype'] ?? null,
        length: props['@length'] ?? null,
        scale: props['@scale'] ?? null,
      };
    });

  const dataSources = arr(findFirst(scenario, 'dataSources')?.DataSource).map((d) => ({
    id: d['@id'] ?? null,
    type: d['@type'] ?? null,
    resourceUri: typeof d.resourceUri === 'string' ? d.resourceUri.trim() : (d.resourceUri?.['#text']?.trim() ?? null),
  }));

  // The logicalModel's split of columns into attributes vs measures. NEO decided
  // this; the emitted projection view must preserve it, because it drives how the
  // column is exposed (a measure carries an aggregationType, an attribute does not).
  const lm = findFirst(scenario, 'logicalModel');
  const lmAttributes = arr(lm?.attributes?.attribute).map((a) => ({
    id: a['@id'] ?? null,
    order: a['@order'] ?? null,
    descriptions: a.descriptions?.['@defaultDescription'] ?? null,
    columnName: a.keyMapping?.['@columnName'] ?? a['@id'] ?? null,
  }));
  const lmMeasures = arr(lm?.baseMeasures?.measure).map((m) => ({
    id: m['@id'] ?? null,
    order: m['@order'] ?? null,
    aggregationType: m['@aggregationType'] ?? 'sum',
    measureType: m['@measureType'] ?? 'simple',
    descriptions: m.descriptions?.['@defaultDescription'] ?? null,
    columnName: m.measureMapping?.['@columnName'] ?? m['@id'] ?? null,
  }));

  // Carried through when NEO declares it; 2 of 353 TECK views do.
  const hasSnapshotProcedures = Object.prototype.hasOwnProperty.call(scenario, 'snapshotProcedures');

  const id = scenario['@id'] ?? null;
  let classification;
  if (!id) classification = CLASS.UNPARSED;
  else if (scriptNodes.length === 1 && otherNodes.length === 0) classification = CLASS.PURE_SCRIPT;
  else if (scriptNodes.length >= 1 && otherNodes.length > 0) classification = CLASS.SCRIPT_PLUS;
  else classification = CLASS.NODE_BASED;

  const baseName = filePath ? path.basename(filePath).replace(/\.(calculationview|hdbcalculationview)$/i, '') : null;
  const descriptions = findFirst(scenario, 'descriptions');
  const logicalModel = findFirst(scenario, 'logicalModel');

  return {
    filePath,
    baseName,
    scenarioId: id,
    dataCategory: scenario['@dataCategory'] ?? null,
    applyPrivilegeType: scenario['@applyPrivilegeType'] ?? null,
    scenarioType: scenario['@calculationScenarioType'] ?? null,
    description: descriptions?.['@defaultDescription'] ?? null,
    logicalModelId: logicalModel?.['@id'] ?? null,
    lmAttributes,
    lmMeasures,
    hasSnapshotProcedures,
    classification,
    nodes,
    script,
    viewAttributes,
    parameters,
    dataSources,
    /**
     * NEO's internal id is unreliable — the reference corpus has 92 views whose
     * id disagrees with their filename. The filename wins downstream.
     */
    idMatchesFilename: baseName != null && id === baseName,
  };
}

/** `NVARCHAR (150)`, `DECIMAL (10, 2)`, or a bare type. */
export function renderColumnType(a) {
  if (!a.datatype) return null;
  if (a.scale != null && a.scale !== '') return `${a.datatype} (${a.length}, ${a.scale})`;
  if (a.length != null && a.length !== '') return `${a.datatype} (${a.length})`;
  return a.datatype;
}

/** `IN PTABID INTEGER` */
export function renderParameter(p, { uppercase = true } = {}) {
  const name = uppercase ? String(p.id).toUpperCase() : p.id;
  let type = p.datatype || 'NVARCHAR';
  if (p.scale != null && p.scale !== '') type += ` (${p.length}, ${p.scale})`;
  else if (p.length != null && p.length !== '') type += ` (${p.length})`;
  return `IN ${name} ${type}`;
}
