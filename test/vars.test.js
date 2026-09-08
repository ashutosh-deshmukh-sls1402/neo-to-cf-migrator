import assert from 'node:assert/strict';
import { constifyVars } from '../src/transform/vars.js';

const go = (src) => constifyVars(src).text;
const refusals = (src) => constifyVars(src).refused;

/* ---------------- what converts ---------------- */

test('a var that is never reassigned becomes const', () => {
  assert.equal(go('function f() { var a = 1; return a; }'), 'function f() { const a = 1; return a; }');
});

test('a var that is reassigned becomes let', () => {
  assert.equal(go('function f() { var a = 1; a = 2; return a; }'), 'function f() { let a = 1; a = 2; return a; }');
});

test('a var with no initialiser becomes let — const needs a value', () => {
  assert.match(go('function f() { var a; a = 2; return a; }'), /let a;/);
});

test('a loop counter is updated, so it becomes let', () => {
  assert.match(go('function f(n) { for (var i = 0; i < n; i++) g(i); }'), /for \(let i = 0;/);
});

test('a for-in key is a fresh binding each iteration, so it becomes const', () => {
  assert.match(go('function f(o) { for (var k in o) g(k); }'), /for \(const k in o\)/);
});

test('one declaration, several names: let unless every one of them is const-safe', () => {
  assert.match(go('function f() { var a = 1, b; return a + b; }'), /let a = 1, b;/);
  assert.match(go('function f() { var a = 1, b = 2; return a + b; }'), /const a = 1, b = 2;/);
});

test('a destructured var converts on the names it binds', () => {
  assert.match(go('function f(o) { var { a, b } = o; return a + b; }'), /const \{ a, b \} = o;/);
});

test('a var closed over by a nested function still converts', () => {
  assert.match(go('function f() { var a = 1; return function () { return a; }; }'), /const a = 1;/);
});

/* ---------------- what is refused, and why ---------------- */

test('a var read outside its block keeps var — let would not be in scope there', () => {
  const src = 'function f(c) { if (c) { var a = 1; } return a; }';
  assert.equal(go(src), src);
});

test('a var read before its declaration keeps var — let would be in the TDZ', () => {
  const src = 'function f() { g(a); var a = 1; return a; }';
  assert.equal(go(src), src);
});

test('a name declared twice keeps var — let would be a redeclaration', () => {
  const src = 'function f() { var a = 1; var a = 2; return a; }';
  assert.equal(go(src), src);
});

test('a var over its own parameter keeps var — let would be a redeclaration', () => {
  const src = 'function f(a) { var a = 1; return a; }';
  assert.equal(go(src), src);
});

test('a var shadowing an OUTER name is its own binding, and converts', () => {
  const out = go('function f(a) { return function () { var a = 1; return a; }; }');
  assert.ok(out.includes('const a = 1'), out);
});

test('the same name declared in two sibling functions converts in both', () => {
  const out = go('function f() { var d = 1; return d; } function g() { var d = 2; return d; }');
  assert.equal(out.match(/const d = /g).length, 2, out);
});

test('a lone-statement body keeps var — a declaration is not legal there', () => {
  const src = 'function f(c) { if (c) var a = 1; return 0; }';
  assert.equal(go(src), src);
});

test('a var hoisted out of a loop body and read after it keeps var — the counter beside it still converts', () => {
  const out = go('function f(n) { for (var i = 0; i < n; i++) { var last = i; } return last; }');
  assert.ok(out.includes('for (let i = 0;'), out);
  assert.match(out, /var last = i;/);
});

/* ---------------- invariants ---------------- */

test('output that would not parse is dropped whole, never half-applied', () => {
  const broken = 'function f( {';
  assert.equal(go(broken), broken);
});

test('a file with no var is returned untouched', () => {
  const src = 'const a = 1;\nexport default a;\n';
  assert.equal(go(src), src);
});

test('the word var inside a string or a name is not a declaration', () => {
  const src = 'const varchar = "var x = 1";\nexport default varchar;\n';
  assert.equal(go(src), src);
});

test('a refusal says which line and which rule stopped it', () => {
  const r = refusals('function f(c) { if (c) { var a = 1; } return a; }');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].names, ['a']);
  assert.match(r[0].reason, /outside the block/);
});

test('a file the conversion left clean reports no refusals', () => {
  assert.deepEqual(refusals('function f() { var a = 1; return a; }'), []);
});
