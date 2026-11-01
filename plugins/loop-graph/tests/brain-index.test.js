'use strict';

// bin/brain-index: only the checks that run before any network use (the indexer itself needs PyPI).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'brain-index');
const run = (env, cwd = os.tmpdir()) => spawnSync(BIN, [], { encoding: 'utf8', cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env } });

test('brain-index is valid bash and documents itself', () => {
  assert.equal(spawnSync('bash', ['-n', BIN]).status, 0);
  const h = spawnSync(BIN, ['--help'], { encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /graphifyy/);
  assert.match(h.stdout, /BRAIN_INDEX_OUT/);
  assert.match(fs.readFileSync(BIN, 'utf8'), /GRAPHIFY_VERSION="0\.9\.100"/);
});

test('brain-index refuses output or exclude paths outside the repository, and non-repos', () => {
  for (const env of [{ BRAIN_INDEX_OUT: '../elsewhere' }, { BRAIN_INDEX_OUT: '/etc' }, { BRAIN_INDEX_EXCLUDE: 'ok ../../x' }]) {
    const r = run(env);
    assert.equal(r.status, 2, JSON.stringify(env));
    assert.match(r.stderr, /must be (a path|paths) inside the repository/);
  }
  const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  const r = run({ CLAUDE_PROJECT_DIR: notRepo });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not inside a git repository/);
});
