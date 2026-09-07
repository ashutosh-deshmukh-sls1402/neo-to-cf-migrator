/**
 * Generate the CF `.hdbcalculationview`.
 *
 * This one has no counterpart in migration-cleanup-toolkit: that tool receives the
 * calc view from SAP's assistant and only patches two attributes on it. Reading
 * NEO alone, there is nothing to patch, so the file is authored here.
 *
 * The transformation is not an edit. A NEO script-based calc view becomes a
 * *projection* over the table function that now holds its script:
 *
 *   NEO                                   CF
 *   ---                                   --
 *   calculationScenarioType=SCRIPT_BASED  outputViewType="Projection"
 *   <calculationViews>                    <calculationViews/>            (emptied)
 *     <calculationView SqlScriptView>     the script moved to the .hdbfunction
 *       <definition>...</definition>
 *   <dataSources/>                        <DataSource type="TABLE_FUNCTION">
 *   logicalModel id="Script_View"         logicalModel id="TABLE_FUNCTION_<base>"
 *   applyPrivilegeType=ANALYTIC_PRIVILEGE applyPrivilegeType="NONE"      (item 3)
 *   dataCategory="DEFAULT"                dataCategory="DIMENSION"       (item 3)
 *
 * NEO's own attribute/measure split is preserved: a measure carries an
 * aggregationType and an attribute does not, so collapsing them would change how
 * the column is exposed.
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Scenario attributes that CF sets regardless of what NEO had. */
const FIXED = [
  ['schemaVersion', '2.3'],
  ['applyPrivilegeType', 'NONE'], // item 3 — the analytic-privilege model is not carried over
  ['defaultClient', '$$client$$'],
  ['defaultLanguage', '$$language$$'],
  ['hierarchiesSQLEnabled', 'false'],
  ['dataCategory', 'DIMENSION'], // item 3 — DEFAULT makes HANA treat it as a cube
  ['enforceSqlExecution', 'false'],
  ['executionSemantic', 'UNDEFINED'],
  ['outputViewType', 'Projection'],
  ['scriptParametersCaseSensitive', 'true'],
];

/**
 * @param {object} cv parsed calc view
 * @param {object} _cfg reserved; no project literals are needed here
 * @param {object} opts
 * @param {string} opts.entityName    flattened UPPER scenario id
 * @param {string} opts.functionName  the table function's name (UPPER)
 * @param {string} [opts.baseName]    NEO file base name; DataSource id keeps its casing
 * @returns {{text:string, dataSourceId:string, warnings:string[]}}
 */
export function generateCalcView(cv, _cfg = {}, opts = {}) {
  const { entityName, functionName } = opts;
  if (!entityName) throw new Error('generateCalcView requires opts.entityName');
  if (!functionName) throw new Error('generateCalcView requires opts.functionName');

  const warnings = [];
  const baseName = opts.baseName ?? cv.baseName;
  // The shipped views keep NEO's casing on the DataSource id while the resourceUri
  // is uppercased. Both appear verbatim in the file, so neither can be normalised.
  const dataSourceId = `TABLE_FUNCTION_${baseName}`;
  const parameters = cv.parameters ?? [];
  const isParameterised = parameters.length > 0;

  if (isParameterised) {
    warnings.push(
      `Parameterised view (${parameters.length} parameter(s)). The parameter passthrough XML ` +
        'has never been verified against a live HDI deploy — deploy-test this view first.',
    );
  }

  const ns = [
    'xmlns:Calculation="http://www.sap.com/ndb/BiModelCalculation.ecore"',
    // Only present when there is a variable mapping to type.
    ...(isParameterised
      ? [
          'xmlns:Variable="http://www.sap.com/ndb/BiModelVariable.ecore"',
          'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
        ]
      : []),
  ].join(' ');

  // `id` sits between schemaVersion and the rest in the shipped files, so the
  // attribute list is split around it rather than emitted from FIXED wholesale.
  const before = FIXED.slice(0, 1); // schemaVersion
  const after = FIXED.slice(1);
  const attrsOf = (pairs) => pairs.map(([k, v]) => `${k}="${v}"`).join(' ');

  const L = [];
  L.push(
    `<?xml version="1.0" encoding="UTF-8"?><Calculation:scenario ${ns} ` +
      `${attrsOf(before)} id="${esc(entityName)}" ${attrsOf(after)}>`,
  );

  L.push(`  <descriptions defaultDescription="${esc(cv.description ?? baseName)}"/>`);

  // --- localVariables: carried over verbatim from NEO ---
  if (!isParameterised) {
    L.push('  <localVariables/>');
  } else {
    L.push('  <localVariables>');
    for (const p of parameters) {
      const len = p.length != null && p.length !== '' ? ` length="${esc(p.length)}"` : '';
      const scale = p.scale != null && p.scale !== '' ? ` scale="${esc(p.scale)}"` : '';
      L.push(`    <variable id="${esc(p.id)}" parameter="true">`);
      L.push('      <descriptions/>');
      L.push(`      <variableProperties datatype="${esc(p.datatype ?? 'NVARCHAR')}"${len}${scale} mandatory="false">`);
      L.push('        <valueDomain type="empty"/>');
      L.push('        <selection multiLine="false" type="SingleValue"/>');
      L.push('      </variableProperties>');
      L.push('    </variable>');
    }
    L.push('  </localVariables>');
  }

  // --- variableMappings: bind each local variable to the function's parameter ---
  if (!isParameterised) {
    L.push('  <variableMappings/>');
  } else {
    L.push('  <variableMappings>');
    for (const p of parameters) {
      L.push(`    <mapping xsi:type="Variable:VariableMapping" dataSource="#${esc(dataSourceId)}">`);
      L.push(`      <targetVariable name="${esc(p.id)}" resourceUri="${esc(functionName)}"/>`);
      L.push(`      <localVariable>#${esc(p.id)}</localVariable>`);
      L.push('    </mapping>');
    }
    L.push('  </variableMappings>');
  }

  // --- the table function this projection reads from ---
  L.push('  <dataSources>');
  L.push(`    <DataSource id="${esc(dataSourceId)}" type="TABLE_FUNCTION">`);
  L.push(`      <resourceUri>${esc(functionName)}</resourceUri>`);
  L.push('    </DataSource>');
  L.push('  </dataSources>');
  // NEO declares this on a few views; carry it rather than hardcode its absence.
  if (cv.hasSnapshotProcedures) L.push('  <snapshotProcedures/>');
  L.push('  <calculationViews/>'); // the script node is gone; it lives in the .hdbfunction now

  // --- logicalModel, preserving NEO's attribute/measure split ---
  L.push(`  <logicalModel id="${esc(dataSourceId)}">`);
  L.push('    <descriptions/>');

  const attributes = cv.lmAttributes ?? [];
  const measures = cv.lmMeasures ?? [];
  if (!attributes.length && !measures.length) {
    warnings.push('NEO declares no logicalModel attributes or measures — the projection would expose no columns.');
  }

  if (!attributes.length) {
    L.push('    <attributes/>');
  } else {
    L.push('    <attributes>');
    for (const a of attributes) {
      const order = a.order != null ? ` order="${esc(a.order)}"` : '';
      L.push(`      <attribute id="${esc(a.id)}"${order} attributeHierarchyActive="false" displayAttribute="false">`);
      L.push('        <descriptions/>');
      L.push(`        <keyMapping columnObjectName="${esc(dataSourceId)}" columnName="${esc(a.columnName ?? a.id)}"/>`);
      L.push('      </attribute>');
    }
    L.push('    </attributes>');
  }
  L.push('    <calculatedAttributes/>');
  L.push('    <privateDataFoundation>');
  L.push('      <tableProxies/>');
  L.push('      <joins/>');
  L.push('      <layout>');
  L.push('        <shapes/>');
  L.push('      </layout>');
  L.push('    </privateDataFoundation>');

  if (!measures.length) {
    L.push('    <baseMeasures/>');
  } else {
    L.push('    <baseMeasures>');
    for (const m of measures) {
      const order = m.order != null ? ` order="${esc(m.order)}"` : '';
      L.push(
        `      <measure id="${esc(m.id)}"${order} aggregationType="${esc(m.aggregationType)}" measureType="${esc(m.measureType)}">`,
      );
      L.push(
        m.descriptions
          ? `        <descriptions defaultDescription="${esc(m.descriptions)}"/>`
          : '        <descriptions/>',
      );
      L.push(`        <measureMapping columnObjectName="${esc(dataSourceId)}" columnName="${esc(m.columnName ?? m.id)}"/>`);
      L.push('      </measure>');
    }
    L.push('    </baseMeasures>');
  }

  L.push('    <calculatedMeasures/>');
  L.push('    <restrictedMeasures/>');
  L.push('    <localDimensions/>');
  L.push('  </logicalModel>');

  L.push('  <layout>');
  L.push('    <shapes>');
  L.push('      <shape modelObjectName="Output" modelObjectNameSpace="MeasureGroup">');
  L.push('        <upperLeftCorner x="40" y="85"/>');
  L.push('        <rectangleSize/>');
  L.push('      </shape>');
  L.push('    </shapes>');
  L.push('  </layout>');
  L.push('</Calculation:scenario>');

  return { text: L.join('\n') + '\n', dataSourceId, warnings };
}
