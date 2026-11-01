'use strict';

// Tests for the deterministic loop evaluator: one failing fixture per rule, the passing example,
// the CLI contract (exit codes, clean failure on bad input) and determinism. Expected rule sets in
// tests/fixtures/expected.json were produced by the Python reference evaluator this is ported from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const E = require('../scripts/lib/loop-eval');
const py = require('../scripts/lib/pycompat');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const LOOP_PATH = path.join(ROOT, 'examples', 'agent-round.md');
const TRACE_PATH = path.join(ROOT, 'examples', 'agent-round.example.jsonl');
const LOOP = fs.readFileSync(LOOP_PATH, 'utf8');
const TRACE = E.loadRun(fs.readFileSync(TRACE_PATH));
const plain = () => fs.readFileSync(TRACE_PATH, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8')).cases;

const resolveFixture = (p) => (/^(graphs|runs)\//.test(p) ? path.join(FIX, p) : path.join(ROOT, p));
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'loop-eval.js'), ...args], { encoding: 'utf8' });

test('the example loop and its trace pass', () => {
  assert.deepEqual(E.evalGraph(LOOP, 'loop'), []);
  assert.deepEqual(E.evalRun(LOOP, TRACE, 't'), []);
});

test('the loop template passes the graph check as shipped', () => {
  assert.deepEqual(E.evalGraph(fs.readFileSync(path.join(ROOT, 'templates', 'loop.md'), 'utf8')), []);
});

test('every rule has at least one failing fixture', () => {
  const covered = new Set(EXPECTED.flatMap((c) => c.rules));
  for (const id of ['G0', 'S1', 'S2', 'S3', 'S4', 'R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']) {
    assert.ok(covered.has(id), `no fixture fails rule ${id}`);
  }
});

for (const c of EXPECTED) {
  test(`fixture ${c.fixture}${c.loop ? ` (loop ${path.basename(c.loop)})` : ''} -> ${c.rules.join(',') || 'PASS'}`, () => {
    const file = resolveFixture(c.fixture);
    let errs;
    if (c.loop) {
      const text = fs.readFileSync(resolveFixture(c.loop), 'utf8');
      try {
        errs = E.evalRun(text, E.loadRun(fs.readFileSync(file)), 't');
      } catch (e) {
        errs = [`R0 ${e.message}`]; // what the CLI prints for an unreadable trace
      }
    } else {
      errs = E.evalGraph(fs.readFileSync(file, 'utf8'), 't');
    }
    assert.deepEqual(E.rules(errs), c.rules, errs.join('\n'));
    const prefix = path.basename(file).split('.')[0];
    if (prefix === 'pass') assert.deepEqual(errs, []);
    else if (/^[GSR]\d$/.test(prefix)) assert.ok(c.rules.includes(prefix), `${prefix} fixture must trip ${prefix}`);
  });
}

test('violation messages name the rule, the place and the problem', () => {
  const bad = LOOP.replace('dispatch -->|agents reported| verify', 'dispatch --> verify');
  assert.deepEqual(E.evalGraph(bad, 'x.md'), ['S1 x.md: edge dispatch --> verify leaves a branching node without a label']);
  const r = plain();
  r[1].label = 'whenever';
  assert.deepEqual(E.evalRun(LOOP, r, 't'), ["R2 t step 2: label 'whenever' must be 'agents reported'"]);
  const maker = plain().map((x) => (x.role === 'verifier' ? { ...x, actor: 'loop-runner' } : x));
  assert.deepEqual(E.evalRun(LOOP, maker, 't'), ["R4 t: actor(s) ['loop-runner'] both produced work and verified it (maker must not accept)"]);
});

test('a failing graph blocks any run (R0) and reports the graph problems as G0', () => {
  const bad = LOOP.replace('dispatch -->|agents reported| verify', 'dispatch --> verify');
  const errs = E.evalRun(bad, TRACE, 't');
  assert.deepEqual(E.rules(errs), ['G0', 'R0']);
  assert.match(errs[0], /^G0 S1 /);
});

test('JSON values keep Python semantics: 0.0 is not an int, true == 1, a falsy label means ""', () => {
  const src = fs.readFileSync(TRACE_PATH, 'utf8');
  const run = (text) => E.rules(E.evalRun(LOOP, E.loadRun(text), 't'));
  assert.deepEqual(run(src.replace('"step":1,', '"step":true,')), []);
  assert.deepEqual(run(src.replace('"step":2,', '"step":2.0,')), []);
  assert.deepEqual(run(src.replace('"label":"","actor":"loop-advisor"', '"label":0,"actor":"loop-advisor"')), []);
  assert.deepEqual(run(src.replace('"ref":"npm test","exit_code":0}', '"ref":"npm test","exit_code":0.0}')), ['R5']);
  assert.deepEqual(run(src.replace('"spent":{"rework_per_piece":1}}', '"spent":{"rework_per_piece":NaN}}')), ['R3']);
});

test('evalRun accepts plain JS objects as well as loadRun output', () => {
  assert.deepEqual(E.evalRun(LOOP, plain(), 't'), []);
});

test('loadRun reports the line of the first bad JSON record, with Python-style messages', () => {
  assert.throws(() => E.loadRun('{"step": 1}\n\n{not json}\n'), /^Error: line 3: invalid JSON \(Expecting property name enclosed in double quotes: line 1 column 2 \(char 1\)\)$/);
  assert.throws(() => E.loadRun('[1,]'), /Illegal trailing comma before end of array: line 1 column 3 \(char 2\)/);
  assert.throws(() => E.loadRun(Buffer.from([0xff, 0x0a])), TypeError);
});

test('repr() matches Python for the values that reach messages', () => {
  assert.equal(py.repr(py.toPy([null, true, 1, 1.5, "it's", 'a"b', { k: [] }])), `[None, True, 1, 1.5, "it's", 'a"b', {'k': []}]`);
  assert.equal(py.repr(new py.PyFloat(1e16)), '1e+16');
  assert.equal(py.repr(new py.PyFloat(1e-5)), '1e-05');
  assert.equal(py.repr(new py.PyFloat(2)), '2.0');
  assert.equal(py.repr('é​\n'), "'é\\u200b\\n'");
});

test('it is deterministic: same input, same verdict, same output', () => {
  const r = plain();
  r[1].to = 'commit';
  assert.deepEqual(E.evalRun(LOOP, r, 't'), E.evalRun(LOOP, r, 't'));
  const a = cli('run', LOOP_PATH, path.join(FIX, 'runs', 'R3.over-budget.jsonl'));
  const b = cli('run', LOOP_PATH, path.join(FIX, 'runs', 'R3.over-budget.jsonl'));
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.status, 1);
});

test('CLI: exit 0 on PASS, 1 on FAIL, 2 on usage errors', () => {
  const g = cli('graph', LOOP_PATH);
  assert.equal(g.status, 0);
  assert.equal(g.stdout, 'PASS\n');
  assert.equal(cli('run', LOOP_PATH, TRACE_PATH).status, 0);
  const bad = cli('graph', path.join(FIX, 'graphs', 'S4.no-non-success-exit.md'));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^FAIL S4 .*\n1 violation\(s\)\n$/);
  assert.equal(cli('run', LOOP_PATH, path.join(FIX, 'runs', 'R7.escalated-without-decision.jsonl')).status, 1);
  for (const args of [[], ['graph'], ['run', LOOP_PATH], ['lint', LOOP_PATH]]) {
    const r = cli(...args);
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}`);
    assert.match(r.stdout, /loop-eval graph/);
  }
});

test('CLI: a bad JSON line, a missing file or invalid UTF-8 fail cleanly (exit 1, no stack trace)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-eval-'));
  const badJson = path.join(d, 't.jsonl');
  fs.writeFileSync(badJson, '{not json}\n');
  const badUtf8 = path.join(d, 'u.jsonl');
  fs.writeFileSync(badUtf8, Buffer.from([0xff, 0x0a]));
  for (const [args, re] of [
    [['run', LOOP_PATH, badJson], /^FAIL R0 line 1: invalid JSON/],
    [['run', LOOP_PATH, path.join(d, 'missing.jsonl')], /^FAIL R0 \[ENOENT\]/],
    [['run', LOOP_PATH, badUtf8], /^FAIL R0 .*invalid UTF-8/],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 1);
    assert.match(r.stdout, re);
    assert.doesNotMatch(r.stderr, /at .*\.js:\d+/);
  }
  const missingLoop = cli('graph', path.join(d, 'nope.md'));
  assert.equal(missingLoop.status, 1);
  assert.match(missingLoop.stderr, /^error: cannot read loop/);
});

test('bin/loop-eval wrapper runs the evaluator', () => {
  const r = spawnSync(path.join(ROOT, 'bin', 'loop-eval'), ['graph', LOOP_PATH], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'PASS\n');
});
