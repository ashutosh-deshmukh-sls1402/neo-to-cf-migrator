import assert from 'node:assert/strict';
import { parseCalcView } from '../src/parse/calcview.js';
import { generateCalcView } from '../src/emit/hdbcalcview.js';
import { generateProxy, cdsType } from '../src/emit/cdsproxy.js';

/** A minimal NEO script-based calc view, shaped like the real ones. */
const view = ({ params = '', snapshot = '', desc = 'Clob' } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<Calculation:scenario xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Calculation="http://www.sap.com/ndb/BiModelCalculation.ecore" id="V" applyPrivilegeType="ANALYTIC_PRIVILEGE" dataCategory="DEFAULT" schemaVersion="2.3" calculationScenarioType="SCRIPT_BASED">
<descriptions defaultDescription="${desc}"/>
<localVariables>${params}</localVariables>
<variableMappings/>
<dataSources/>${snapshot}
<calculationViews>
  <calculationView xsi:type="Calculation:SqlScriptView" id="Script_View">
    <viewAttributes>
      <viewAttribute id="COL" datatype="INTEGER"/>
      <viewAttribute id="PAYLOAD" datatype="CLOB"/>
    </viewAttributes>
    <definition>BEGIN
var_out = select 1 as COL, 'x' as PAYLOAD from DUMMY;
END /********* End Procedure Script ************/</definition>
  </calculationView>
</calculationViews>
<logicalModel id="Script_View">
  <attributes>
    <attribute id="PAYLOAD" order="2">
      <keyMapping columnObjectName="Script_View" columnName="PAYLOAD"/>
    </attribute>
  </attributes>
  <baseMeasures>
    <measure id="COL" order="1" aggregationType="count" measureType="simple">
      <descriptions defaultDescription="COL"/>
      <measureMapping columnObjectName="Script_View" columnName="COL"/>
    </measure>
  </baseMeasures>
</logicalModel>
</Calculation:scenario>`;

const PARAM = `<variable id="ROLE" parameter="true"><variableProperties datatype="NVARCHAR" length="100" mandatory="false"/></variable>`;

const gen = (xml, opts = {}) =>
  generateCalcView(parseCalcView(xml, '/x/V.calculationview'), {}, {
    entityName: 'S_M_VIEWS_V',
    functionName: 'S_M_VIEWS_TABLE_FUNCTION_V',
    baseName: 'V',
    ...opts,
  }).text;

/* ---------------- parser ---------------- */

test('parser keeps NEO attribute/measure split apart', () => {
  const cv = parseCalcView(view(), '/x/V.calculationview');
  assert.deepEqual(cv.lmAttributes.map((a) => a.id), ['PAYLOAD']);
  assert.deepEqual(cv.lmMeasures.map((m) => m.id), ['COL']);
  assert.equal(cv.lmMeasures[0].aggregationType, 'count');
});

test('parser classifies a single SqlScriptView as PURE_SCRIPT', () => {
  assert.equal(parseCalcView(view(), '/x/V.calculationview').classification, 'PURE_SCRIPT');
});

/* ---------------- calc view emitter ---------------- */

test('the two item-3 attributes are forced regardless of what NEO said', () => {
  const out = gen(view());
  assert.match(out, /dataCategory="DIMENSION"/);
  assert.match(out, /applyPrivilegeType="NONE"/);
  assert.doesNotMatch(out, /dataCategory="DEFAULT"/);
  assert.doesNotMatch(out, /ANALYTIC_PRIVILEGE/);
});

test('the script node is emptied — the script now lives in the table function', () => {
  const out = gen(view());
  assert.match(out, /<calculationViews\/>/);
  assert.doesNotMatch(out, /SqlScriptView/);
  assert.doesNotMatch(out, /<definition>/);
});

test('a TABLE_FUNCTION DataSource replaces NEO empty dataSources', () => {
  const out = gen(view());
  assert.match(out, /<DataSource id="TABLE_FUNCTION_V" type="TABLE_FUNCTION">/);
  assert.match(out, /<resourceUri>S_M_VIEWS_TABLE_FUNCTION_V<\/resourceUri>/);
});

test('logicalModel is re-anchored to the DataSource, not NEO Script_View', () => {
  const out = gen(view());
  assert.match(out, /<logicalModel id="TABLE_FUNCTION_V">/);
  assert.match(out, /columnObjectName="TABLE_FUNCTION_V"/);
  assert.doesNotMatch(out, /Script_View/);
});

test('measures keep their aggregationType; attributes do not gain one', () => {
  const out = gen(view());
  assert.match(out, /<measure id="COL" order="1" aggregationType="count" measureType="simple">/);
  assert.match(out, /<attribute id="PAYLOAD" order="2" attributeHierarchyActive="false"/);
});

test('an unparameterised view emits empty localVariables and variableMappings', () => {
  const out = gen(view());
  assert.match(out, /<localVariables\/>/);
  assert.match(out, /<variableMappings\/>/);
  assert.doesNotMatch(out, /xmlns:Variable/);
});

test('a parameterised view gains the Variable namespace and a mapping', () => {
  const out = gen(view({ params: PARAM }));
  assert.match(out, /xmlns:Variable="http:\/\/www\.sap\.com\/ndb\/BiModelVariable\.ecore"/);
  assert.match(out, /<variable id="ROLE" parameter="true">/);
  assert.match(out, /<mapping xsi:type="Variable:VariableMapping" dataSource="#TABLE_FUNCTION_V">/);
  assert.match(out, /<targetVariable name="ROLE" resourceUri="S_M_VIEWS_TABLE_FUNCTION_V"\/>/);
  assert.match(out, /<localVariable>#ROLE<\/localVariable>/);
});

test('a parameterised view warns — the passthrough XML is deploy-unverified', () => {
  const r = generateCalcView(parseCalcView(view({ params: PARAM }), '/x/V.calculationview'), {}, {
    entityName: 'E', functionName: 'F', baseName: 'V',
  });
  assert.ok(r.warnings.some((w) => /never been verified against a live HDI deploy/.test(w)));
});

test('snapshotProcedures is carried through only when NEO declares it', () => {
  assert.doesNotMatch(gen(view()), /snapshotProcedures/);
  assert.match(gen(view({ snapshot: '\n<snapshotProcedures/>' })), /<snapshotProcedures\/>/);
});

test('the description is escaped on the way out, not injected raw', () => {
  // The fixture must itself be valid XML, so the source is already escaped here.
  // It parses to `a & b "c"` and must be re-escaped when emitted.
  const out = gen(view({ desc: 'a &amp; b &quot;c&quot;' }));
  assert.match(out, /defaultDescription="a &amp; b &quot;c&quot;"/);
});

test('emitters refuse to run without the names they cannot derive', () => {
  const cv = parseCalcView(view(), '/x/V.calculationview');
  assert.throws(() => generateCalcView(cv, {}, { functionName: 'F' }), /entityName/);
  assert.throws(() => generateCalcView(cv, {}, { entityName: 'E' }), /functionName/);
});

/* ---------------- cds proxy ---------------- */

test('proxy carries both persistence annotations and every column', () => {
  const out = generateProxy(parseCalcView(view(), '/x/V.calculationview'), {}, { entityName: 'S_V' }).text;
  assert.match(out, /@cds\.persistence\.exists/);
  assert.match(out, /@cds\.persistence\.calcview/);
  assert.match(out, /entity S_V \{/);
  assert.match(out, /COL\s+: Integer/);
  assert.match(out, /PAYLOAD : hana\.CLOB/);
});

test('HANA INTEGER is 32-bit, so it maps to CDS Integer (not Integer64)', () => {
  assert.equal(cdsType({ id: 'C', datatype: 'INTEGER' }).type, 'Integer');
  assert.equal(cdsType({ id: 'C', datatype: 'BIGINT' }).type, 'Integer64');
});

test('an unmapped HANA type is refused, never guessed as String', () => {
  const r = cdsType({ id: 'C', datatype: 'ST_GEOMETRY' });
  assert.equal(r.type, null);
  assert.match(r.warning, /No CDS mapping/);
});

test('a key named by the caller is marked; one that does not exist is reported', () => {
  const cv = parseCalcView(view(), '/x/V.calculationview');
  assert.match(generateProxy(cv, {}, { entityName: 'E', keys: ['COL'] }).text, /key COL/);
  const bad = generateProxy(cv, {}, { entityName: 'E', keys: ['NOPE'] });
  assert.ok(bad.warnings.some((w) => /does not exist on this view/.test(w)));
});
