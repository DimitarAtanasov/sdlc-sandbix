'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'is',
  'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'we', 'i', 'will',
  'should', 'must', 'into', 'from', 'when', 'then', 'so', 'not',
]);

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
      if (entry.isFile && entry.isFile() && /\.(md|mdx|txt)$/i.test(entry.name)) {
        found.push(path.join(entry.path || full, entry.name));
        if (found.length >= maxFiles) return found;
      }
    }
  }
  return found;
}

/**
 * Cosine Distance to Specs (H factor input).
 * v1 heuristic: pure term-frequency cosine similarity against any specs/*.md
 * found in the repo (no embedding model - keeps the gate deterministic and
 * LLM-free per section 6 of the orchestration spec). Distance = 1 - bestMatch.
 * Returns { distance, specsFound, bestMatch } so callers can see when the
 * 0.5 neutral default (no specs directory) was used instead of a real score.
 */
function cosineDistanceToSpecs(repoRoot, taskDescription, capBytes = 200_000) {
  const files = findSpecFiles(repoRoot);
  if (!files.length) {
    return { distance: 0.5, specsFound: false, bestMatch: null };
  }
  const taskTf = termFreq(tokenize(taskDescription));
  let best = 0;
  let bestFile = null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > capBytes) continue;
      const content = fs.readFileSync(file, 'utf8');
      const sim = cosine(taskTf, termFreq(tokenize(content)));
      if (sim > best) {
        best = sim;
        bestFile = path.relative(repoRoot, file);
      }
    } catch {
      // skip unreadable file
    }
  }
  return { distance: 1 - best, specsFound: true, bestMatch: bestFile };
}

module.exports = { tokenize, termFreq, cosine, findSpecFiles, cosineDistanceToSpecs };
