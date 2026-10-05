'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'is',
  'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'we', 'i', 'will',
  'should', 'must', 'into', 'from', 'when', 'then', 'so', 'not',
]);

// Below this best-match similarity a spec says nothing about the task, so its
// distance is not evidence of ambiguity (see cosineDistanceToSpecs).
const RELEVANCE_FLOOR = 0.05;
const NEUTRAL_DISTANCE = 0.5;

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t)
  );
}

function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

function cosine(tfA, tfB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, count] of tfA) {
    normA += count * count;
    if (tfB.has(term)) dot += count * tfB.get(term);
  }
  for (const count of tfB.values()) normB += count * count;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function findSpecFiles(repoRoot, dirs = ['specs', 'docs/specs'], maxFiles = 50) {
  const found = [];
  for (const dir of dirs) {
    const full = path.join(repoRoot, dir);
    let entries;
    try {
      entries = fs.readdirSync(full, { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && /\.(md|mdx|txt)$/i.test(entry.name)) {
        found.push(path.join(entry.parentPath || entry.path || full, entry.name));
        if (found.length >= maxFiles) return found;
      }
    }
  }
  return found;
}

/**
 * Cosine Distance to Specs (H factor input).
 * Deterministic term-frequency cosine similarity against specs/**\/*.md (no
 * embedding model, so the gate stays LLM-free). Distance = 1 - bestMatch.
 *
 * A spec that shares (almost) no vocabulary with the task is not evidence the
 * task is ambiguous - it is simply unrelated - so when the best similarity is
 * below RELEVANCE_FLOOR the distance falls back to the neutral 0.5, exactly as
 * when no specs exist. Without this, every small task unrelated to any spec
 * scored H=50 and could never reach Level 1.
 *
 * Returns { distance, specsFound, relevant, bestSimilarity, bestMatch }.
 */
function cosineDistanceToSpecs(repoRoot, taskDescription, opts = {}) {
  const { capBytes = 200_000, floor = RELEVANCE_FLOOR, neutral = NEUTRAL_DISTANCE } = opts;
  const files = findSpecFiles(repoRoot);
  if (!files.length) {
    return { distance: neutral, specsFound: false, relevant: false, bestSimilarity: 0, bestMatch: null };
  }
  const taskTf = termFreq(tokenize(taskDescription || ''));
  let best = 0;
  let bestFile = null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > capBytes) continue;
      const sim = cosine(taskTf, termFreq(tokenize(fs.readFileSync(file, 'utf8'))));
      if (sim > best) {
        best = sim;
        bestFile = path.relative(repoRoot, file);
      }
    } catch {
      // skip unreadable file
    }
  }
  const relevant = best >= floor;
  return {
    distance: relevant ? 1 - best : neutral,
    specsFound: true,
    relevant,
    bestSimilarity: best,
    bestMatch: relevant ? bestFile : null,
  };
}

module.exports = {
  tokenize, termFreq, cosine, findSpecFiles, cosineDistanceToSpecs,
  RELEVANCE_FLOOR, NEUTRAL_DISTANCE,
};
