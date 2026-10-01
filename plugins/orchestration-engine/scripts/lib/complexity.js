'use strict';

const path = require('node:path');
const git = require('./git');
const { cosineDistanceToSpecs } = require('./textsim');

const CHURN_WINDOW_DAYS = 30;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Resolves which files the task touches and how many lines moved.
 * Prefers real git diff/untracked-file state (implementation already
 * started); falls back to a text-length heuristic for a task that's still
 * just a description, with no working-tree changes yet.
 */
function resolveTargets(repoRoot, taskDescription, explicitFiles) {
  const diffed = git.diffNumstat(repoRoot);
  const untracked = git.untrackedFiles(repoRoot);
  const changed = [...diffed, ...untracked];

  if (changed.length) {
    return {
      mode: 'diff',
      files: changed.map((c) => c.file),
      deltaLines: changed.reduce((sum, c) => sum + c.lines, 0),
    };
  }

  const tracked = new Set(git.listTrackedFiles(repoRoot));
  const mentioned = new Set(explicitFiles || []);
  if (taskDescription) {
    const pathLike = taskDescription.match(/[\w./-]+\.[A-Za-z0-9]{1,8}/g) || [];
    for (const candidate of pathLike) {
      const normalized = candidate.replace(/^\.\//, '');
      if (tracked.has(normalized)) mentioned.add(normalized);
      else {
        const byBasename = [...tracked].find((f) => path.basename(f) === path.basename(normalized));
        if (byBasename) mentioned.add(byBasename);
      }
    }
  }

  const wordCount = (taskDescription || '').split(/\s+/).filter(Boolean).length;
  const estimatedDeltaLines = clamp(Math.round(wordCount / 3), 1, 500);

  return {
    mode: 'estimate',
    files: [...mentioned],
    deltaLines: estimatedDeltaLines,
    fCountFloor: mentioned.size === 0 ? 1 : mentioned.size,
  };
}

function structuralMutationScore(deltaLines, fCount) {
  return 1.5 * deltaLines + 10.0 * fCount;
}

function dependencyCouplingDepth(repoRoot, files) {
  let total = 0;
  const perFile = [];
  for (const file of files) {
    const inbound = git.inboundReferences(repoRoot, file);
    const outbound = git.outboundDependencies(repoRoot, file);
    perFile.push({ file, inbound, outbound });
    total += inbound + outbound;
  }
  return { total, perFile };
}

function historicalUncertaintyDensity(repoRoot, files, taskDescription, config) {
  const gitChurn = git.churn(repoRoot, files, CHURN_WINDOW_DAYS);
  const specs = cosineDistanceToSpecs(repoRoot, taskDescription);
  const H = config.churnWeight * gitChurn + config.specDistanceWeight * specs.distance;
  return { H, gitChurn, specs };
}

function magnitude(S, D, H) {
  return Math.sqrt(0.4 * S * S + 0.4 * D * D + 0.2 * H * H);
}

/**
 * Computes the Complexity Vector C = [S, D, H] and Magnitude M for a task,
 * per section 6.1 of the orchestration engine spec. Pure static analysis -
 * no LLM call involved.
 */
function computeComplexityVector(repoRoot, taskDescription, explicitFiles, userConfig = {}) {
  const config = { churnWeight: 2.0, specDistanceWeight: 50.0, ...userConfig };
  if (!git.isGitRepo(repoRoot)) {
    throw new Error(`Not a git repository: ${repoRoot}`);
  }

  const target = resolveTargets(repoRoot, taskDescription, explicitFiles);
  const fCount = target.files.length || target.fCountFloor || 1;

  const S = structuralMutationScore(target.deltaLines, fCount);
  const { total: D, perFile: coupling } = dependencyCouplingDepth(repoRoot, target.files);
  const { H, gitChurn, specs } = historicalUncertaintyDensity(repoRoot, target.files, taskDescription, config);
  const M = magnitude(S, D, H);

  return {
    vector: { S, D, H },
    magnitude: M,
    inputs: {
      mode: target.mode,
      files: target.files,
      fCount,
      deltaLines: target.deltaLines,
      gitChurn30d: gitChurn,
      cosineDistanceToSpecs: specs.distance,
      specsFound: specs.specsFound,
      specRelevant: specs.relevant,
      closestSpec: specs.bestMatch,
      coupling,
    },
  };
}

module.exports = { computeComplexityVector, magnitude, CHURN_WINDOW_DAYS };
