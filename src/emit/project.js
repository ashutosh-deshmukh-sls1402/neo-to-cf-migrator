/**
 * The project shell — the files that make an emitted `db/` + `srv/` pair into a
 * CAP project that `npm install`, `cds build` and `cf deploy` recognise.
 *
 * This sits right on the edge of D8 ("the tool migrates what is in NEO and does
 * not scaffold CF-only utilities"). The line drawn here: D8 is about *code the
 * developer wrote* — validation helpers, rate limiting, an error-logging
 * `server.js`. A `package.json` is not that. Without it the 1,656 converted
 * files cannot be installed, built or started, and the developer hand-writes the
 * same three files every time.
 *
 * Everything emitted here is derived, never invented:
 *
 *   dependencies   the bare specifiers the emitted handlers actually import
 *                  (measured: exactly `@sap/cds` and, where a destination call
 *                  was converted, `@sap-cloud-sdk/http-client`), plus the two
 *                  the `cds` config below implies — the HANA driver and xssec.
 *   "type":module  the handlers are ES modules because `$.import` became `import`.
 *   destination    a resource only when a destination call was converted.
 *   foreign schema one `existing-service` per schema the NEO tree reads and does
 *                  not own. The service *name* is a deployment fact we cannot
 *                  know, so it is emitted as a marked placeholder, not a guess.
 *
 * What is deliberately NOT emitted, because NEO does not contain it:
 *   - `srv/server.js` — the shipped CF's is error logging the developer added.
 *   - scopes and role templates. NEO's `.xsprivileges` declare one privilege,
 *     `Execute`; the nine role scopes in the shipped `xs-security.json` came
 *     from the launchpad design, not from the NEO tree. Guessing them would be
 *     inventing an authorisation model.
 */

/**
 * `srv/index.cds` — the model root.
 *
 * CAP resolves `srv/` by looking for `srv/index.cds` or `srv/*.cds`; it does not
 * walk into `srv/lib/**`. Without this file every emitted service is invisible
 * and `cds compile srv` reports no model at all. One `using` per service, which
 * is exactly what the shipped CF's own `srv/index.cds` does.
 */
function srvIndexCds(servicePaths) {
  const lines = servicePaths
    .map((p) => p.replace(/^srv\//, './').replace(/\.cds$/, ''))
    .sort()
    .map((p) => `using from '${p}';`);
  return `// The model root. CAP loads srv/index.cds; the services live below it.\n${lines.join('\n')}\n`;
}

/** The HDI deployer module — what mta.yaml's `type: hdb` module runs. */
const dbPackageJson = () => JSON.stringify({
  name: 'deploy',
  dependencies: { '@sap/hdi-deploy': '^5', '@sap/hana-client': '^2' },
  scripts: { start: 'node node_modules/@sap/hdi-deploy/deploy.js' },
}, null, 2) + '\n';

/** Versions taken from the shipped CF, which is known to build and deploy. */
const VERSIONS = {
  '@sap/cds': '^9',
  '@cap-js/hana': '^2',
  '@sap/xssec': '^4',
  '@sap-cloud-sdk/http-client': '^4',
  '@sap/cds-dk': '^9',
};

const ID = ({ schema, app }) => [schema, app].filter(Boolean).join('_');
const npmName = (id) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const yamlList = (items, indent) => items.map((i) => `\n${indent}${i}`).join('');

function packageJson({ id, needsSdk }) {
  const deps = {
    '@cap-js/hana': VERSIONS['@cap-js/hana'],
    '@sap/cds': VERSIONS['@sap/cds'],
    '@sap/xssec': VERSIONS['@sap/xssec'],
  };
  if (needsSdk) deps['@sap-cloud-sdk/http-client'] = VERSIONS['@sap-cloud-sdk/http-client'];

  return JSON.stringify({
    name: npmName(id),
    version: '1.0.0',
    description: `${id}, migrated from SAP NEO by neo-to-cf-migrator`,
    license: 'UNLICENSED',
    private: true,
    // The emitted handlers are ES modules — `$.import` became `import`.
    type: 'module',
    engines: { node: '>=20' },
    scripts: {
      start: 'cds-serve',
      watch: 'cds watch',
      build: 'cds build --production',
      deploy: 'cds deploy',
    },
    dependencies: Object.fromEntries(Object.entries(deps).sort()),
    devDependencies: { '@sap/cds-dk': VERSIONS['@sap/cds-dk'] },
    cds: {
      requires: {
        db: 'hana',
        auth: 'xsuaa',
      },
    },
  }, null, 2) + '\n';
}

function xsSecurityJson({ id }) {
  return JSON.stringify({
    xsappname: id,
    'tenant-mode': 'dedicated',
    scopes: [],
    attributes: [],
    'role-templates': [],
  }, null, 2) + '\n';
}

function mtaYaml({ id, schema, app, needsSdk, foreignSchemas }) {
  const srvRequires = [`- name: ${id}-auth`, `- name: ${id}-db`];
  if (needsSdk) srvRequires.push(`- name: ${id}-destination`);

  const dbRequires = [`- name: ${id}-db`, '  properties:', '    TARGET_CONTAINER: ~{hdi-service-name}'];
  const resources = [];

  for (const fs of foreignSchemas) {
    dbRequires.push(
      `# ${fs}: read-only cross-container access. Needs db/src/${fs}.hdbgrants and a`,
      '# synonym config; neither is in the NEO tree, so neither is emitted here.',
      `- name: ${fs}-db`,
      '  group: SERVICE_REPLACEMENTS',
      '  properties:',
      `    key: ${fs}-db-hdi`,
      `    service: ~{${fs.toLowerCase()}-db-hdi}`,
    );
    resources.push(
      `  # NOT created here — the ${fs} container must already exist in this space.`,
      `  # TODO: set service-name to the real HDI service, which is a deployment`,
      '  #       fact the NEO tree does not record.',
      `  - name: ${fs}-db`,
      '    type: org.cloudfoundry.existing-service',
      '    parameters:',
      `      service-name: ${fs}-db`,
      '    properties:',
      `      ${fs.toLowerCase()}-db-hdi: \${service-name}`,
      '',
    );
  }

  return `_schema-version: 3.3.0

ID: ${id}
version: 1.0.0
description: ${[schema, app].filter(Boolean).join(' ')} — migrated from SAP NEO

parameters:
  enable-parallel-deployments: true

modules:
  - name: ${id}-srv
    type: nodejs
    path: gen/srv
    parameters:
      instances: 1
      buildpack: nodejs_buildpack
      memory: 512M
    build-parameters:
      builder: custom
      commands: []
      ignore:
        - node_modules/
    provides:
      - name: srv-api
        properties:
          srv-url: \${default-url}
    requires:${yamlList(srvRequires, '      ')}

  - name: ${id}-db-deployer
    type: hdb
    path: gen/db
    parameters:
      buildpack: nodejs_buildpack
      memory: 256M
    build-parameters:
      builder: custom
      commands: []
      ignore:
        - node_modules/
    requires:${yamlList(dbRequires, '      ')}

resources:
  - name: ${id}-auth
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: ./xs-security.json
      config:
        xsappname: ${id}
        tenant-mode: dedicated

  - name: ${id}-db
    type: com.sap.xs.hdi-container
    parameters:
      service: hana
      service-plan: hdi-shared
    properties:
      hdi-service-name: \${service-name}
${needsSdk ? `
  - name: ${id}-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite
` : ''}${resources.length ? '\n' + resources.join('\n') : ''}`;
}

/**
 * @param {{schema:string, app:?string, needsSdk:boolean, foreignSchemas:string[]}} info
 * @returns {{files:{path:string,text:string}[], findings:object[]}}
 */
export function generateProject(info) {
  const id = ID(info);
  const foreignSchemas = [...new Set(info.foreignSchemas || [])].sort();
  const opts = { ...info, id, foreignSchemas };

  const findings = [];
  if (foreignSchemas.length) {
    findings.push({
      level: 'warning',
      code: 'MTA_FOREIGN_CONTAINER',
      message:
        `mta.yaml references ${foreignSchemas.length} existing HDI container(s): ${foreignSchemas.join(', ')}. ` +
        'The service names are placeholders.',
      fix: 'Set each `service-name` to the real container, and add the .hdbgrants/.hdbsynonymconfig those references need.',
    });
  }
  findings.push({
    level: 'note',
    code: 'PROJECT_AUTH_EMPTY',
    message: 'xs-security.json is emitted with no scopes — NEO\'s .xsprivileges declare only `Execute`.',
    fix: 'Add the role templates and scopes the application needs; they cannot be derived from the NEO tree.',
  });

  const servicePaths = info.servicePaths || [];
  if (!servicePaths.length) {
    findings.push({
      level: 'warning',
      code: 'NO_SERVICE_MODEL',
      message: 'No service.cds was emitted, so srv/index.cds would be empty and CAP would serve nothing.',
      fix: 'Check that the .xsodata files were found — without them there is no service to expose.',
    });
  }

  return {
    files: [
      { path: 'package.json', text: packageJson(opts) },
      { path: 'mta.yaml', text: mtaYaml(opts) },
      { path: 'xs-security.json', text: xsSecurityJson(opts) },
      { path: 'db/package.json', text: dbPackageJson() },
      // HDI drops nothing on redeploy unless told to; an empty list is the
      // shipped project's own setting and the safe default.
      { path: 'db/undeploy.json', text: '[]\n' },
      ...(servicePaths.length ? [{ path: 'srv/index.cds', text: srvIndexCds(servicePaths) }] : []),
    ],
    findings,
  };
}
