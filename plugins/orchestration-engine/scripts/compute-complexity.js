#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { computeComplexityVector } = require('./lib/complexity');
const { decideExecutionMatrix } = require('./lib/matrix');

function parseArgs(argv) {
  const args = { files: [], json: false, task: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--files') args.files = (argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--repo') args.repo = argv[++i];
    else rest.push(a);
  }
  args.task = rest.join(' ').trim();
  return args;
}

function readUserConfig() {
  const config = {};
  for (const key of ['TIER1MODEL', 'TIER2MODEL', 'TIER3MODEL', 'DECLINEDHARDCEILING', 'DECISIONTTLHOURS']) {
    const envVar = `CLAUDE_PLUGIN_OPTION_${key}`;
    if (process.env[envVar] !== undefined) {
      const camel = key
        .toLowerCase()
        .replace(/^tier(\d)model$/, 'tier$1Model')
        .replace(/^declinedhardceiling$/, 'declineDHardCeiling')
        .replace(/^decisionttlhours$/, 'decisionTtlHours');
      const raw = process.env[envVar];
      config[camel] = /^[0-9.]+$/.test(raw) ? Number(raw) : raw;
    }
  }
  return config;
}

function pluginDataDir() {
  return process.env.CLAUDE_PLUGIN_DATA || path.join(require('node:os').tmpdir(), 'orchestration-engine-data');
}

function persistDecision(result) {
  try {
    const dir = pluginDataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'last-decision.json'),
      JSON.stringify({ ...result, computedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    process.stderr.write(`[orchestration-engine] warning: could not persist decision: ${err.message}\n`);
  }
}

function formatReport(task, result) {
  const { vector, magnitude, inputs } = result.complexity;
  const m = result.matrix;
  const lines = [];
  lines.push(`# Orchestration Engine - Complexity Vector & Matrix`);
  lines.push('');
  if (task) lines.push(`Task: ${task}`);
  lines.push(`Analysis mode: ${inputs.mode === 'diff' ? 'working-tree diff' : 'pre-implementation estimate'}`);
  lines.push(`Files considered (${inputs.fCount}): ${inputs.files.length ? inputs.files.join(', ') : '(none resolved - greenfield task)'}`);
  lines.push('');
  lines.push(`## Complexity Vector C = [S, D, H]`);
  lines.push(`- S (Structural Mutation):        ${vector.S.toFixed(2)}  (deltaLines=${inputs.deltaLines}, fCount=${inputs.fCount})`);
  lines.push(`- D (Dependency & Coupling Depth): ${vector.D.toFixed(2)}  (sum of inbound+outbound refs across files)`);
  lines.push(`- H (Historical Uncertainty):      ${vector.H.toFixed(2)}  (churn30d=${inputs.gitChurn30d}, cosineDistanceToSpecs=${inputs.cosineDistanceToSpecs.toFixed(2)}${inputs.specsFound ? `, closest=${inputs.closestSpec}` : ', no specs/ found - neutral default'})`);
  lines.push('');
  lines.push(`## Magnitude M = ${magnitude.toFixed(2)}`);
  lines.push('');
  lines.push(`## Execution Matrix: ${m.levelName} (${m.magnitudeRange})`);
  lines.push(`- Pipeline strategy: ${m.pipelineStrategy}`);
  lines.push(`- Model tier: ${m.modelTier.tier} -> use model="${m.modelTier.model}" for the Agent tool`);
  lines.push(`- Token cap: ${m.tokenCap.description}`);
  lines.push(`- 3-way decision: **${m.threeWayDecision.decision.toUpperCase()}** - ${m.threeWayDecision.reason}`);
  if (m.threeWayDecision.skipSteps.length) {
    lines.push(`- Steps to skip: ${m.threeWayDecision.skipSteps.join(', ')}`);
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(args.repo || process.env.CLAUDE_PROJECT_DIR || process.cwd());

  let stdinTask = '';
  if (!process.stdin.isTTY && !args.task) {
    try {
      stdinTask = fs.readFileSync(0, 'utf8').trim();
    } catch {
      // no stdin available
    }
  }
  const task = args.task || stdinTask;

  const complexity = computeComplexityVector(repoRoot, task, args.files);
  const matrix = decideExecutionMatrix(complexity, readUserConfig());
  const result = { task, repoRoot, complexity, matrix };

  persistDecision(result);

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(task, result) + '\n');
  }
}

main();
