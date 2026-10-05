'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gitRepo, write } = require('./helpers');
const { cosineDistanceToSpecs, cosine, termFreq, tokenize } = require('../scripts/lib/textsim');

test('cosine of identical text is 1, disjoint text is 0', () => {
  const a = termFreq(tokenize('payload validation endpoint'));
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9);
  assert.equal(cosine(a, termFreq(tokenize('kafka offset commit'))), 0);
});

test('no specs directory -> neutral distance', () => {
  const repo = gitRepo({ 'a.txt': 'x' });
  const r = cosineDistanceToSpecs(repo, 'anything');
  assert.deepEqual([r.distance, r.specsFound, r.relevant], [0.5, false, false]);
});

test('unrelated spec is neutral, not maximal ambiguity (the over-flagging fix)', () => {
  const repo = gitRepo({ 'specs/a.md': 'Kafka consumer offset commit retry policy for the billing topic.' });
  const r = cosineDistanceToSpecs(repo, 'Fix a typo in the README');
  assert.equal(r.specsFound, true);
  assert.equal(r.relevant, false);
  assert.equal(r.distance, 0.5);
  assert.equal(r.bestMatch, null);
});

test('related spec yields a distance below neutral and names the closest file', () => {
  const repo = gitRepo({
    'specs/api.md': 'Scripted REST API payload validation for the needit table request fields.',
    'specs/other.md': 'Kafka consumer offset commit retry policy.',
  });
  const r = cosineDistanceToSpecs(repo, 'Add payload validation to the scripted REST API request fields');
  assert.equal(r.relevant, true);
  assert.ok(r.distance < 0.5, `distance ${r.distance}`);
  assert.equal(r.bestMatch.replace(/\\/g, '/'), 'specs/api.md');
});
