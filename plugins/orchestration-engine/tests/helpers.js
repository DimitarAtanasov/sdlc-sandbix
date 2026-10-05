'use strict';

const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

function tmpDir(prefix = 'oe-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function gitRepo(files = {}) {
  const dir = tmpDir('oe-repo-');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  if (Object.keys(files).length) {
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  }
  return dir;
}

function write(dir, file, content) {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Runs a plugin script with isolated plugin-data; returns { stdout, stderr, status }. */
function run(script, { input, args = [], env = {}, cwd } = {}) {
  const r = spawnSync('node', [path.join(SCRIPTS, script), ...args], {
    input: input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd,
    env: { ...process.env, CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_ENV_FILE: '', ...env },
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** Like run(), but concurrent: resolves { stdout, stderr, status } when the process exits. */
function runAsync(script, { input, args = [], env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(SCRIPTS, script), ...args], { cwd, env: { ...process.env, CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CLAUDE_ENV_FILE: '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ stdout, stderr, status }));
    child.stdin.end(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input));
  });
}

function json(out) {
  return out.stdout ? JSON.parse(out.stdout) : null;
}

module.exports = { SCRIPTS, tmpDir, gitRepo, write, run, runAsync, json };
