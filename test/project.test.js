import assert from 'node:assert/strict';
import { generateProject } from '../src/emit/project.js';

const gen = (o = {}) => {
  const r = generateProject({ schema: 'S', app: 'APP', needsSdk: false, foreignSchemas: [], ...o });
  return { ...r, file: (p) => r.files.find((f) => f.path === p).text };
};

test('the shell files are emitted', () => {
  assert.deepEqual(
    gen({ servicePaths: ['srv/lib/A/Services/service.cds'] }).files.map((f) => f.path).sort(),
    ['db/package.json', 'db/undeploy.json', 'mta.yaml', 'package.json', 'srv/index.cds', 'xs-security.json'],
  );
});

test('srv/index.cds names every emitted service — CAP does not walk srv/lib', () => {
  const r = gen({ servicePaths: ['srv/lib/B/Services/service.cds', 'srv/lib/A/Services/service.cds'] });
  const lines = r.file('srv/index.cds').trim().split('\n').slice(1);
  assert.deepEqual(lines, [
    "using from './lib/A/Services/service';",
    "using from './lib/B/Services/service';",
  ]);
});

test('no services means no model root, and it says so rather than emitting an empty one', () => {
  const r = gen();
  assert.ok(!r.files.some((f) => f.path === 'srv/index.cds'));
  assert.ok(r.findings.some((f) => f.code === 'NO_SERVICE_MODEL'));
});

test('the handlers are ES modules, so the package must say so', () => {
  // `$.import` became `import`; without "type": "module" nothing starts.
  assert.equal(JSON.parse(gen().file('package.json')).type, 'module');
});

test('the SDK dependency appears only when a destination call was converted', () => {
  const without = JSON.parse(gen().file('package.json')).dependencies;
  const with_ = JSON.parse(gen({ needsSdk: true }).file('package.json')).dependencies;
  assert.ok(!('@sap-cloud-sdk/http-client' in without));
  assert.ok('@sap-cloud-sdk/http-client' in with_);
  // The two the cds config implies are always there.
  for (const d of ['@sap/cds', '@cap-js/hana']) assert.ok(d in without, d);
});

test('the destination service is a resource only when something calls one', () => {
  assert.ok(!/service: destination/.test(gen().file('mta.yaml')));
  assert.match(gen({ needsSdk: true }).file('mta.yaml'), /service: destination/);
});

/**
 * The failure that actually breaks a deploy: a module requires a resource name
 * that no resource provides. Cheap to check without a YAML parser, and it is the
 * one thing string templating gets wrong.
 */
test('every name a module requires is a resource the file defines', () => {
  const yaml = gen({ needsSdk: true, foreignSchemas: ['OTHER', 'THIRD'] }).file('mta.yaml');
  const [modules, resources] = yaml.split('\nresources:');
  assert.ok(resources, 'the file has a resources section');

  // Only names under a `requires:` — `provides: - name: srv-api` is a module's
  // own output, not a resource it consumes.
  const required = [];
  let inRequires = false;
  for (const line of modules.split('\n')) {
    if (/^ {4}\w[\w-]*:/.test(line)) inRequires = /^ {4}requires:/.test(line);
    const m = inRequires && /^ {6}- name: (\S+)/.exec(line);
    if (m) required.push(m[1]);
  }
  const defined = new Set([...resources.matchAll(/^ {2}- name: (\S+)/gm)].map((m) => m[1]));
  assert.ok(required.length >= 4, `expected several requires, got ${required.length}`);
  for (const r of required) assert.ok(defined.has(r), `${r} is required but never defined`);
});

test('YAML is indented with spaces only — a tab makes the file unparseable', () => {
  assert.ok(!/\t/.test(gen({ needsSdk: true, foreignSchemas: ['OTHER'] }).file('mta.yaml')));
});

test('a foreign schema becomes an existing-service, and says the name is a placeholder', () => {
  const r = gen({ foreignSchemas: ['OTHER', 'OTHER'] });
  const yaml = r.file('mta.yaml');
  assert.equal((yaml.match(/type: org\.cloudfoundry\.existing-service/g) || []).length, 1, 'deduped');
  assert.match(yaml, /TODO: set service-name/);
  assert.ok(r.findings.some((f) => f.code === 'MTA_FOREIGN_CONTAINER'));
});

test('no scopes are invented — NEO does not have them', () => {
  const sec = JSON.parse(gen().file('xs-security.json'));
  assert.deepEqual(sec.scopes, []);
  assert.deepEqual(sec['role-templates'], []);
  assert.ok(gen().findings.some((f) => f.code === 'PROJECT_AUTH_EMPTY'));
});

test('a tree with no app still gets a usable id', () => {
  assert.equal(JSON.parse(gen({ app: null }).file('xs-security.json')).xsappname, 'S');
  assert.equal(JSON.parse(gen({ app: null }).file('package.json')).name, 's');
});
