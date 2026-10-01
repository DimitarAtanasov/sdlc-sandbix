'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../scripts/lib/lifecycle');
const { decideExecutionMatrix } = require('../scripts/lib/matrix');
const { magnitude } = require('../scripts/lib/complexity');
const { DEFAULTS } = require('../scripts/lib/config');

const newRun = (S, D, H, cfg = {}) => {
  const vector = { S, D, H };
  const result = { matrix: decideExecutionMatrix({ vector, magnitude: magnitude(S, D, H) }, { ...DEFAULTS, ...cfg }) };
  return L.beginRun(result, { ...DEFAULTS, ...cfg });
};
const L1 = () => newRun(5, 0, 0);
const L2 = () => newRun(30, 0, 10);
const L3 = () => newRun(120, 10, 10);

const approve = (run, step, extra = {}) => {
  assert.equal(L.checkStart(run, step).allow, true, `${step} should be startable`);
  L.markStarted(run, step);
  return L.recordReport(run, step, { decision: 'draft', verdict: 'approve', confidence: 0.9, ...extra });
};

test('stepFor maps agent names to steps', () => {
  const cases = {
    'spec-eval-agent': 'spec-eval',
    'sdlc-agents:tech-design-agent': 'tech-design',
    'tech-design-eval-agent': 'tech-design-eval',
    'implementation-agent': 'implementation',
    'documentation-agent': 'documentation',
    'testing-agent': 'testing',
    'service-now-architect': null,
    Explore: null,
  };
  for (const [name, step] of Object.entries(cases)) assert.equal(L.stepFor(name), step, name);
});

test('stepForCall only falls back to the description for generic agents', () => {
  assert.equal(L.stepForCall({ subagent_type: 'general-purpose', description: 'Write tests' }), 'testing');
  assert.equal(L.stepForCall({ subagent_type: 'Explore', description: 'Find test files' }), null);
});

test('level 1 skips design/eval and goes straight to implementation', () => {
  const run = L1();
  for (const s of ['spec-eval', 'tech-design', 'tech-design-eval']) {
    const c = L.checkStart(run, s);
    assert.equal(c.allow, false);
    assert.match(c.reason, /skipped/);
  }
  assert.equal(approve(run, 'implementation').nextAction, 'run:documentation|testing');
});

test('level 1 coerces ask_clarification and decline to draft', () => {
  const run = L1();
  L.markStarted(run, 'implementation');
  const r = L.recordReport(run, 'implementation', { decision: 'decline', summary: 'nope' });
  assert.equal(r.status, 'approved');
  assert.equal(run.halted, false);
  assert.match(r.coerced[0], /Level 1/);
});

test('level 2 enforces sequential gating', () => {
  const run = L2();
  assert.equal(L.checkStart(run, 'tech-design').allow, false);
  assert.match(L.checkStart(run, 'implementation').reason, /spec-eval/);
  approve(run, 'spec-eval');
  approve(run, 'tech-design');
  assert.equal(L.checkStart(run, 'implementation').allow, false); // eval not done
  approve(run, 'tech-design-eval');
  approve(run, 'implementation');
  assert.equal(L.checkStart(run, 'documentation').allow, true);
  assert.equal(L.checkStart(run, 'testing').allow, true);
  approve(run, 'testing');
  assert.equal(run.completed, false);
  assert.equal(approve(run, 'documentation').nextAction, 'done');
  assert.equal(run.completed, true);
});

test('ask_clarification blocks the pipeline until the step is re-run', () => {
  const run = L2();
  L.markStarted(run, 'spec-eval');
  const r = L.recordReport(run, 'spec-eval', { decision: 'ask_clarification', missing_info: ['Which table?'] });
  assert.equal(r.nextAction, 'ask_user');
  assert.deepEqual(run.pendingQuestions, ['Which table?']);
  assert.equal(L.checkStart(run, 'tech-design').allow, false);
  L.markStarted(run, 'spec-eval'); // re-spawn after the user answered
  assert.equal(run.clarified, true);
  assert.deepEqual(run.pendingQuestions, []);
});

test('H > 40 forces the first step to ask, once', () => {
  const run = newRun(30, 0, 45);
  assert.equal(run.requireClarification, true);
  assert.match(L.startNotes(run, 'spec-eval').join(' '), /MUST end with decision 'ask_clarification'/);
  L.markStarted(run, 'spec-eval');
  const r = L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'approve', confidence: 0.99 });
  assert.equal(r.status, 'needs_clarification');
  assert.match(r.coerced.join(' '), /H > 40/);
  L.markStarted(run, 'spec-eval');
  assert.equal(L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'approve', confidence: 0.99 }).status, 'approved');
});

test('low-confidence draft is downgraded at level 2 but not level 1', () => {
  const run = L2();
  L.markStarted(run, 'spec-eval');
  assert.equal(L.recordReport(run, 'spec-eval', { decision: 'draft', confidence: 0.2 }).status, 'needs_clarification');
  const l1 = L1();
  L.markStarted(l1, 'implementation');
  assert.equal(L.recordReport(l1, 'implementation', { decision: 'draft', confidence: 0.2 }).status, 'approved');
});

test('decline halts the whole pipeline', () => {
  const run = L2();
  L.markStarted(run, 'spec-eval');
  const r = L.recordReport(run, 'spec-eval', { decision: 'decline', summary: 'no requirements' });
  assert.equal(r.nextAction, 'abort');
  assert.equal(run.halted, true);
  assert.match(L.checkStart(run, 'implementation').reason, /halted/i);
});

test('level 3 decline gate halts before any agent runs', () => {
  const run = newRun(120, 70, 10);
  assert.equal(run.halted, true);
  assert.equal(L.checkStart(run, 'spec-eval').allow, false);
});

test('revise sends tech-design-eval back to tech-design, then re-evaluates', () => {
  const run = L2();
  approve(run, 'spec-eval');
  approve(run, 'tech-design');
  L.markStarted(run, 'tech-design-eval');
  const r = L.recordReport(run, 'tech-design-eval', { decision: 'draft', verdict: 'revise', summary: 'missing error handling' });
  assert.equal(r.nextAction, 'rerun:tech-design');
  assert.equal(run.steps['tech-design'].status, 'needs_rework');
  assert.equal(L.checkStart(run, 'tech-design-eval').allow, false);
  assert.equal(L.checkStart(run, 'tech-design').allow, true);
  approve(run, 'tech-design');
  assert.equal(run.steps['tech-design-eval'].status, 'pending');
  assert.equal(approve(run, 'tech-design-eval').status, 'approved');
});

test('level 3 requires multiple isolated eval cycles', () => {
  const run = L3();
  assert.equal(run.policy.minCycles, 2);
  L.markStarted(run, 'spec-eval');
  const first = L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'approve', confidence: 0.9 });
  assert.deepEqual([first.status, first.nextAction], ['needs_cycle', 'rerun:spec-eval']);
  assert.equal(L.checkStart(run, 'tech-design').allow, false);
  assert.equal(approve(run, 'spec-eval').status, 'approved');
});

test('level 3 isolation loop gives up after maxEvalCycles of revisions', () => {
  const run = newRun(120, 10, 10, { maxEvalCycles: 2 });
  L.markStarted(run, 'spec-eval');
  assert.equal(L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'revise' }).status, 'revise');
  L.markStarted(run, 'spec-eval');
  const r = L.recordReport(run, 'spec-eval', { decision: 'draft', verdict: 'revise' });
  assert.equal(r.nextAction, 'abort');
  assert.match(run.haltReason, /exhausted/);
});

test('parseDecisionBlock reads the last block, tolerates fences, rejects junk', () => {
  assert.deepEqual(L.parseDecisionBlock('x <decision>{"decision":"draft"}</decision> y <decision>{"decision":"decline"}</decision>'), { decision: 'decline' });
  assert.deepEqual(L.parseDecisionBlock('<decision>\n```json\n{"decision":"draft"}\n```\n</decision>'), { decision: 'draft' });
  assert.equal(L.parseDecisionBlock('<decision>not json</decision>'), null);
  assert.equal(L.parseDecisionBlock('no block'), null);
});
