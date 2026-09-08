/**
 * Action handlers that answer their caller. The unit is a set of emitted files
 * plus the `.xsodata` bindings, because "is this function a handler?" is a
 * question only the service wiring can answer.
 */

import assert from 'node:assert/strict';
import { ensureHandlerReturns } from '../src/emit/returns.js';
import { handlerReturn } from '../src/ai/tasks.js';

const HANDLER = 'srv/lib/S/MOD/Library/handlers/MyLib.js';
const wired = [{ alias: 'aliasOne', fn: 'doThing', target: HANDLER }];
const files = (text) => [{ path: HANDLER, text, role: 'handler' }];

/** A backend that always answers the same thing, and counts the calls. */
const backend = (answer) => {
  const calls = [];
  return { calls, name: 'stub', ask: (p) => { calls.push(p); return answer; } };
};

const codes = (r) => r.findings.map((f) => f.code);

test('a handler that already returns a value is left alone', () => {
  const f = files('export function doThing(req) {\n  var out = 1;\n  return out;\n}\n');
  const r = ensureHandlerReturns(f, wired, backend('{"variable":"out"}'));
  assert.equal(r.added, 0);
  assert.deepEqual(r.findings, []);
  assert.doesNotMatch(f[0].text, /AI-CHOSEN/);
});

test('a handler that returns nothing is reported, with the values in scope', () => {
  const f = files('export function doThing(req) {\n  var out = [];\n  out.push(1);\n}\n');
  const r = ensureHandlerReturns(f, wired, null);
  assert.deepEqual(codes(r), ['HANDLER_NO_RETURN']);
  assert.match(r.findings[0].message, /aliasOne/);
  assert.match(r.findings[0].fix, /out/);
  assert.equal(f[0].text.includes('return'), false);
});

test('a bare `return;` is not an answer', () => {
  const f = files('export function doThing(req) {\n  var out = 1;\n  if (!req) return;\n}\n');
  assert.deepEqual(codes(ensureHandlerReturns(f, wired, null)), ['HANDLER_NO_RETURN']);
});

test('a return inside a callback belongs to the callback, not the handler', () => {
  const f = files('export function doThing(req) {\n  var out = 1;\n  [1].forEach(function (x) { return x; });\n}\n');
  assert.deepEqual(codes(ensureHandlerReturns(f, wired, null)), ['HANDLER_NO_RETURN']);
});

test('the AI tier picks a variable and THIS code writes the return', () => {
  const f = files('export function doThing(req) {\n  var out = [];\n  out.push(1);\n}\n');
  const ai = backend('{"variable":"out"}');
  const r = ensureHandlerReturns(f, wired, ai);
  assert.equal(r.added, 1);
  assert.deepEqual(codes(r), ['AI_RETURN_ADDED']);
  assert.match(f[0].text, /\n  return out;\n\}/);
  // and the reader is told a model decided it
  assert.match(f[0].text, /AI-CHOSEN RETURN/);
  // the prompt asserts the facts: the function itself and the candidate names
  assert.match(ai.calls[0], /out\.push\(1\)/);
});

test('the model answering `unknown` leaves the finding, and costs nothing else', () => {
  const f = files('export function doThing(req) {\n  var out = [];\n}\n');
  const ai = backend('{"variable":"unknown"}');
  const r = ensureHandlerReturns(f, wired, ai);
  assert.deepEqual(codes(r), ['HANDLER_NO_RETURN']);
  assert.equal(ai.calls.length, 1, 'unknown is an answer, not a rejection to retry');
});

test('a handler cannot answer with its own req, however sure the model is', () => {
  const f = files('export function doThing(req) {\n  var out = [];\n}\n');
  const ai = backend('{"variable":"req"}');
  const r = ensureHandlerReturns(f, wired, ai);
  assert.deepEqual(codes(r), ['HANDLER_NO_RETURN']);
  assert.doesNotMatch(f[0].text, /return req/);
  assert.equal(ai.calls.length, 2, 'one retry, with the reason attached');
  assert.match(ai.calls[1], /parameter of this function/);
});

test('a name that is out of scope where the return goes is refused', () => {
  const f = files('export function doThing(req) {\n  var out = [];\n  if (req) { const inner = 2; }\n}\n');
  const r = ensureHandlerReturns(f, wired, backend('{"variable":"inner"}'));
  assert.deepEqual(codes(r), ['HANDLER_NO_RETURN']);
  assert.doesNotMatch(f[0].text, /return inner/);
});

test('a name nothing ever assigns to would return undefined, so it is refused', () => {
  const f = files('export function doThing(req) {\n  var out;\n}\n');
  const r = ensureHandlerReturns(f, wired, backend('{"variable":"out"}'));
  assert.deepEqual(codes(r), ['HANDLER_NO_RETURN']);
});

test('a handler whose library failed to convert is not this pass\'s business', () => {
  const r = ensureHandlerReturns([], wired, null);
  assert.deepEqual(r.findings, []);
});

test('two aliases served by one function are one question, not two', () => {
  const f = files('export function doThing(req) {\n  var out = 1;\n}\n');
  const ai = backend('{"variable":"out"}');
  ensureHandlerReturns(f, [...wired, { alias: 'aliasTwo', fn: 'doThing', target: HANDLER }], ai);
  assert.equal(ai.calls.length, 1);
});

test('the task refuses an answer that is not JSON of the shape asked for', () => {
  const ctx = { fn: { params: [], body: { body: [] } }, candidates: ['out'] };
  assert.match(handlerReturn.validate(handlerReturn.parse('sorry, no idea'), ctx).reject, /not \{"variable"/);
  assert.match(handlerReturn.validate({ variable: 'nope' }, ctx).reject, /not one of the listed/);
});

test('a `var` inside a try is still in scope at the closing brace, a `const` is not', () => {
  const f = files('export function doThing(req) {\n  try { var out = 1; const tmp = 2; } catch (e) { out = 0; }\n}\n');
  const r = ensureHandlerReturns(f, wired, null);
  assert.match(r.findings[0].fix, /scope at the end are: out.$/);
});

/* ---------------- `asked` — telling "nothing eligible" from "never called" ---------------- */

test('asked counts every handler put to the model, whether it answered or not', () => {
  const f = files('export function doThing(req) {\n  var out = 1;\n}\n');
  const r = ensureHandlerReturns(f, wired, backend('{"variable":"unknown"}'));
  assert.equal(r.asked, 1);
  assert.equal(r.added, 0);
});

test('asked is 0 with no backend — the model was never reachable, not declined', () => {
  const f = files('export function doThing(req) {\n  var out = 1;\n}\n');
  const r = ensureHandlerReturns(f, wired, null);
  assert.equal(r.asked, 0);
});

test('asked is 0 when there is no candidate to offer — nothing to ask about', () => {
  const f = files('export function doThing(req) {\n}\n');
  const r = ensureHandlerReturns(f, wired, backend('{"variable":"unknown"}'));
  assert.equal(r.asked, 0);
  assert.equal(r.calls?.length, undefined);
});

test('a handler that already returns a value is never asked', () => {
  const f = files('export function doThing(req) {\n  var out = 1;\n  return out;\n}\n');
  const ai = backend('{"variable":"out"}');
  const r = ensureHandlerReturns(f, wired, ai);
  assert.equal(r.asked, 0);
  assert.equal(ai.calls.length, 0);
});
