'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function git(repoRoot, args) {
  try {
    return execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

function isGitRepo(repoRoot) {
  return git(repoRoot, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** Tracked files changed relative to HEAD (staged + unstaged), with added/removed line counts. */
function diffNumstat(repoRoot) {
  const out = git(repoRoot, ['diff', '--numstat', 'HEAD']);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, file] = line.split('\t');
      const a = added === '-' ? 0 : Number(added);
      const r = removed === '-' ? 0 : Number(removed);
      return { file, added: a, removed: r, lines: a + r };
    });
}

/** Untracked files (new files not yet added), counted by their current line count. */
function untrackedFiles(repoRoot, capBytes = 200_000) {
  // --untracked-files=all forces git to expand new directories into their
  // individual files instead of collapsing them to a single "?? dir/" entry.
  const out = git(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (!out) return [];
  return out
    .split('\n')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((file) => {
      const full = path.join(repoRoot, file);
      let lines = 10;
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.size <= capBytes) {
          lines = fs.readFileSync(full, 'utf8').split('\n').length;
        }
      } catch {
        // unreadable/binary/deleted between status and read - keep default estimate
      }
      return { file, added: lines, removed: 0, lines };
    });
}

function listTrackedFiles(repoRoot) {
  const out = git(repoRoot, ['ls-files']);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** Count of distinct commits touching any of `files` in the last `days` days. */
function churn(repoRoot, files, days) {
  if (!files.length) return 0;
  const since = `--since=${days}.days`;
  const out = git(repoRoot, ['log', since, '--pretty=format:%H', '--', ...files]);
  if (!out) return 0;
  return new Set(out.split('\n').filter(Boolean)).size;
}

/** Number of tracked files (other than `file` itself) whose content references file's basename. */
function inboundReferences(repoRoot, file, cap = 200) {
  const base = path.basename(file, path.extname(file));
  if (!base || base.length < 2) return 0;
  const out = git(repoRoot, [
    'grep', '-l', '-F', '-I', base, '--',
    ':(exclude)' + file,
  ]);
  if (!out) return 0;
  return Math.min(out.split('\n').filter(Boolean).length, cap);
}

const IMPORT_LIKE = /^\s*(import\s|from\s+\S+\s+import|require\(|using\s+[A-Za-z_]|#include|\$ref\s*[:=])/;

/** Count of import/using/require-like lines inside a tracked file (cheap outbound-dependency proxy). */
function outboundDependencies(repoRoot, file, cap = 200) {
  const full = path.join(repoRoot, file);
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 1_000_000) return 0;
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    let count = 0;
    for (const line of lines) {
      if (IMPORT_LIKE.test(line)) count++;
      if (count >= cap) break;
    }
    return count;
  } catch {
    return 0;
  }
}

module.exports = {
  isGitRepo,
  diffNumstat,
  untrackedFiles,
  listTrackedFiles,
  churn,
  inboundReferences,
  outboundDependencies,
};
