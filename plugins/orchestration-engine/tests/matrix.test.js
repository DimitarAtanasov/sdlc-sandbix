'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideExecutionMatrix, levelFor } = require('../scripts/lib/matrix');
const { magnitude } = require('../scripts/lib/complexity');

const decide = (S, D, H, cfg) => {
  const vector = { S, D, H };
  return decideExecutionMatrix({ vector, magnitude: magnitude(S, D, H) }, cfg);
};

test('magnitude is the weighted Euclidean norm from the spec', () => {
  assert.equal(magnitude(10, 0, 0), Math.sqrt(0.4 * 100));
  assert.equal(magnitude(0, 10, 0), Math.sqrt(0.4 * 100));
  assert.equal(magnitude(0, 0, 10), Math.sqrt(0.2 * 100));
});

test('level boundaries: <15, 15..70 inclusive, >70', () => {
  assert.equal(levelFor(14.99), 1);
  assert.equal(levelFor(15), 2);
  assert.equal(levelFor(70), 2);
  assert.equal(levelFor(70.01), 3);
});

test('level 1: skip design/eval, haiku, 5k cap, draft only', () => {
  const m = decide(5, 0, 0);
  assert.equal(m.level, 1);
  assert.equal(m.modelTier.model, 'haiku');
  assert.equal(m.tokenCap.capTokens, 5000);
  assert.equal(m.threeWayDecision.decision, 'draft');
  assert.deepEqual(m.threeWayDecision.skipSteps, ['spec-eval', 'tech-design', 'tech-design-eval']);
});

test('level 2: dynamic cap scales 50k..150k with M; H>40 yields to ask_clarification', () => {
  const near15 = decide(37.5, 0, 0); // M ~= 23.7
  assert.equal(near15.level, 2);
  assert.ok(near15.tokenCap.capTokens > 50_000 && near15.tokenCap.capTokens < 150_000);
  const ask = decide(30, 0, 41);
  assert.equal(ask.level, 2);
  assert.equal(ask.threeWayDecision.decision, 'ask_clarification');
  assert.equal(ask.threeWayDecision.forceClarification, true);
  assert.equal(decide(30, 0, 40).threeWayDecision.decision, 'draft');
});

test('level 3: opus, uncapped, decline when D exceeds the ceiling', () => {
  const ok = decide(120, 30, 10);
  assert.equal(ok.level, 3);
  assert.equal(ok.modelTier.model, 'opus');
  assert.equal(ok.tokenCap.capTokens, null);
  assert.equal(ok.threeWayDecision.decision, 'draft');
  assert.equal(decide(120, 61, 10).threeWayDecision.decision, 'decline');
  assert.equal(decide(120, 61, 10, { declineDHardCeiling: 100 }).threeWayDecision.decision, 'draft');
});

test('model tiers are configurable', () => {
  assert.equal(decide(120, 0, 0, { tier1Model: 'fable' }).modelTier.model, 'fable');
});
