'use strict';

// Curated lessons: a short, capped, human-approved list of project rules that
// the pipeline learned the hard way. Lives at .sdlc/lessons.md in the project.
// Edits are made in the working tree and travel with the PR, so merging the PR
// is the human approval. The cap keeps the context cost small and forces
// pruning instead of an ever-growing file.

const fs = require('node:fs');
const path = require('node:path');

const MAX_LESSONS = 20;
const MAX_BYTES = 2000;
const HEADER = `# Lessons

Short rules this project learned the hard way. Capped at ${MAX_LESSONS} lines / ${MAX_BYTES} bytes;
prune before adding. Changes are proposed in a PR, so merging is the approval.

`;

function lessonsFile(repoRoot) {
  return path.join(repoRoot, '.sdlc', 'lessons.md');
}

function read(repoRoot) {
  try {
    return fs.readFileSync(lessonsFile(repoRoot), 'utf8');
  } catch {
    return '';
  }
}

function bullets(text) {
  return text.split('\n').filter((l) => /^- /.test(l));
}

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function write(repoRoot, lines) {
  const file = lessonsFile(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, HEADER + lines.join('\n') + (lines.length ? '\n' : ''));
}

function list(repoRoot) {
  return bullets(read(repoRoot));
}

function add(repoRoot, rule, why, today = new Date().toISOString().slice(0, 10)) {
  const clean = String(rule || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, reason: 'A lesson needs a non-empty rule.' };
  if (clean.length > 200) return { ok: false, reason: 'Keep a lesson under 200 characters: one rule, not a story.' };
  const lines = list(repoRoot);
  const key = normalize(clean);
  if (lines.some((l) => normalize(l).includes(key))) return { ok: false, reason: 'That lesson already exists.' };
  const line = `- ${clean}${why ? ` (why: ${String(why).replace(/\s+/g, ' ').trim()})` : ''} [${today}]`;
  if (lines.length + 1 > MAX_LESSONS || Buffer.byteLength(HEADER + [...lines, line].join('\n')) > MAX_BYTES) {
    return { ok: false, reason: `Lessons are full (max ${MAX_LESSONS} lines / ${MAX_BYTES} bytes). Remove or merge one first: sdlc-lessons remove <n>.` };
  }
  write(repoRoot, [...lines, line]);
  return { ok: true, count: lines.length + 1 };
}

function remove(repoRoot, n) {
  const lines = list(repoRoot);
  const i = Number(n) - 1;
  if (!Number.isInteger(i) || i < 0 || i >= lines.length) return { ok: false, reason: `No lesson ${n}. There are ${lines.length}.` };
  const [gone] = lines.splice(i, 1);
  write(repoRoot, lines);
  return { ok: true, removed: gone };
}

/** The text injected into sessions and subagent prompts (empty when there are no lessons). */
function injection(repoRoot) {
  const lines = list(repoRoot);
  if (!lines.length) return '';
  return `Project lessons (.sdlc/lessons.md - follow these; they are human-approved):\n${lines.join('\n')}`;
}

module.exports = { MAX_LESSONS, MAX_BYTES, lessonsFile, list, add, remove, injection };
