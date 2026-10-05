'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gitRepo, write } = require('./helpers');
const { computeComplexityVector } = require('../scripts/lib/complexity');

test('estimate mode: S follows 1.5*dL + 10*F and M the weighted norm', () => {
  const repo = gitRepo({ 'a.txt': 'x\n' });
  const r = computeComplexityVector(repo, 'Fix a typo in the README');
  assert.equal(r.inputs.mode, 'estimate');
  const { deltaLines, fCount } = r.inputs;
  assert.equal(r.vector.S, 1.5 * deltaLines + 10 * fCount);
  const { S, D, H } = r.vector;
  assert.ok(Math.abs(r.magnitude - Math.sqrt(0.4 * S * S + 0.4 * D * D + 0.2 * H * H)) < 1e-9);
});

test('diff mode: counts changed + untracked files and added/removed lines', () => {
  const repo = gitRepo({ 'a.cs': 'line1\nline2\n', 'b.cs': 'x\n' });
  write(repo, 'a.cs', 'line1\nCHANGED\nextra\n');
  write(repo, 'c.cs', 'new\nfile\n');
  const r = computeComplexityVector(repo, 'task');
  assert.equal(r.inputs.mode, 'diff');
  assert.deepEqual([...r.inputs.files].sort(), ['a.cs', 'c.cs']);
  assert.ok(r.inputs.deltaLines >= 5);
});

test('D counts inbound references and outbound imports', () => {
  const repo = gitRepo({
    'Svc.cs': 'using System;\nusing Kafka;\nclass Svc {}\n',
    'A.cs': 'var s = new Svc();\n',
    'B.cs': 'Svc.Run();\n',
  });
  write(repo, 'Svc.cs', 'using System;\nusing Kafka;\nclass Svc { int x; }\n');
  const r = computeComplexityVector(repo, 'task');
  const svc = r.inputs.coupling.find((c) => c.file === 'Svc.cs');
  assert.equal(svc.inbound, 2);
  assert.equal(svc.outbound, 2);
  assert.equal(r.vector.D, 4);
});

test('H uses git churn and the configurable weights', () => {
  const repo = gitRepo({ 'a.txt': 'x\n' });
  write(repo, 'a.txt', 'y\n');
  const base = computeComplexityVector(repo, 'task', [], { churnWeight: 2, specDistanceWeight: 50 });
  const lowered = computeComplexityVector(repo, 'task', [], { churnWeight: 2, specDistanceWeight: 10 });
  assert.equal(base.inputs.gitChurn30d, 1);
  assert.equal(base.vector.H, 2 * 1 + 50 * 0.5);
  assert.equal(lowered.vector.H, 2 * 1 + 10 * 0.5);
});

test('non-git directory is rejected', () => {
  assert.throws(() => computeComplexityVector(require('./helpers').tmpDir(), 'task'), /Not a git repository/);
});
