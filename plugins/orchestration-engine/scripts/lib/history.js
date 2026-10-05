'use strict';

// Run history: one JSON line per finished pipeline run (completed, halted, or
// abandoned when a new /orchestrate replaces an unfinished one). It turns
// "is this agent worth having?" from an opinion into counts. Stored in the
// project at .sdlc/history.jsonl so it is committed with the work and survives
// ephemeral (web) containers; falls back to the plugin data dir outside a repo.
// Task text is truncated to 200 chars.

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const { STEPS, MULTI_CYCLE_STEPS: EVAL_STEPS } = require('./lifecycle');

const MIN_RUNS = 5; // below this a step's rates are not trusted

function historyFile(repoRoot) {
  return repoRoot ? path.join(repoRoot, '.sdlc', 'history.jsonl') : path.join(store.dataDir(), 'history.jsonl');
}

function entryFromRun(run, outcome, sid) {
  return {
    at: new Date().toISOString(),
    sid,
    task: run.task || '',
    level: run.level,
    magnitude: run.magnitude,
    vector: run.vector,
    outcome,
    hotfix: Boolean(run.hotfix),
    haltReason: run.haltReason || null,
    steps: Object.fromEntries(
      Object.entries(run.steps).map(([name, st]) => [name, {
        status: st.status,
        attempts: st.attempts,
        cycles: st.cycles,
        revisions: st.revisions || 0,
        clarifications: st.clarifications || 0,
      }])
    ),
  };
}

/** Logs a run once. Returns true if the run was modified (caller must persist it). */
function closeRun(sid, run, outcome) {
  if (!run || run.logged) return false;
  try {
    const file = historyFile(run.repoRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entryFromRun(run, outcome, sid)) + '\n');
  } catch {
    return false; // history is best-effort; never break the pipeline for it
  }
  run.logged = true;
  return true;
}

/** Logs a run that just reached a terminal state (completed or halted). */
function closeIfFinished(sid, run) {
  if (run.completed) return closeRun(sid, run, 'completed');
  if (run.halted) return closeRun(sid, run, 'halted');
  return false;
}

/** Logs a run that is being superseded by a new one; untouched runs are not worth logging. */
function closeAsReplaced(sid, run) {
  if (!run || run.logged) return false;
  if (closeIfFinished(sid, run)) return true;
  const touched = Object.values(run.steps).some((st) => st.attempts > 0);
  return touched ? closeRun(sid, run, 'abandoned') : false;
}

function readAll(repoRoot) {
  let raw;
  try {
    raw = fs.readFileSync(historyFile(repoRoot), 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

const pct = (n, d) => (d ? Math.round((100 * n) / d) : null);

function summarize(entries, minRuns = MIN_RUNS) {
  const outcomes = { completed: 0, halted: 0, abandoned: 0 };
  const byLevel = {};
  const steps = Object.fromEntries(STEPS.map((s) => [s, {
    ran: 0, approved: 0, skipped: 0, neverRan: 0, declined: 0, revisions: 0, clarifications: 0, extraCycles: 0,
  }]));

  for (const e of entries) {
    outcomes[e.outcome] = (outcomes[e.outcome] || 0) + 1;
    const lvl = (byLevel[e.level] ||= { runs: 0, completed: 0, halted: 0, abandoned: 0 });
    lvl.runs += 1;
    lvl[e.outcome] = (lvl[e.outcome] || 0) + 1;
    for (const [name, st] of Object.entries(e.steps || {})) {
      const agg = steps[name];
      if (!agg) continue;
      if (st.status === 'skipped') { agg.skipped += 1; continue; }
      if (!st.attempts) { agg.neverRan += 1; continue; }
      agg.ran += 1;
      if (st.status === 'approved') agg.approved += 1;
      if (st.status === 'declined') agg.declined += 1;
      agg.revisions += st.revisions;
      agg.clarifications += st.clarifications;
      agg.extraCycles += Math.max(0, st.attempts - 1);
    }
  }

  const signals = [];
  for (const [name, a] of Object.entries(steps)) {
    a.approvalRate = pct(a.approved, a.ran);
    a.revisionRate = pct(a.revisions, a.ran);
    a.clarificationRate = pct(a.clarifications, a.ran);
    a.declineRate = pct(a.declined, a.ran);
    if (a.ran < minRuns) {
      if (a.ran > 0) signals.push(`${name}: only ${a.ran} run(s) - not enough data (need ${minRuns}).`);
      continue;
    }
    // Only review steps can rubber-stamp; a producer that succeeds first time is simply working.
    if (EVAL_STEPS.has(name) && a.approved === a.ran && !a.revisions && !a.clarifications && a.extraCycles === 0) {
      signals.push(`${name}: approved first time in all ${a.ran} runs with no revisions or questions - rubber-stamp candidate (merge it into its producer or make it conditional).`);
    }
    if (a.declineRate >= 30) signals.push(`${name}: declined in ${a.declineRate}% of runs - a frequent blocker; check its inputs or the upstream step.`);
    if (a.clarificationRate >= 50) signals.push(`${name}: asks for clarification in ${a.clarificationRate}% of runs - upstream spec is likely too thin.`);
    if (a.revisionRate >= 50) signals.push(`${name}: requests revisions in ${a.revisionRate}% of runs - the producing step is weak, or this eval is too strict.`);
  }
  return { runs: entries.length, minRuns, outcomes, byLevel, steps, signals };
}

function formatSummary(sum) {
  if (!sum.runs) return 'No pipeline runs recorded yet. Run /orchestrate on real tasks first; history is logged when a run completes, halts, or is replaced.';
  const lines = [`Runs: ${sum.runs} (completed ${sum.outcomes.completed}, halted ${sum.outcomes.halted}, abandoned ${sum.outcomes.abandoned})`];
  for (const [lvl, v] of Object.entries(sum.byLevel)) lines.push(`  Level ${lvl}: ${v.runs} runs, ${v.completed || 0} completed, ${v.halted || 0} halted, ${v.abandoned || 0} abandoned`);
  lines.push('', 'step              ran  appr%  rev%  ask%  decl%  skipped');
  for (const [name, a] of Object.entries(sum.steps)) {
    const f = (v) => String(v === null ? '-' : v).padStart(5);
    lines.push(`${name.padEnd(17)} ${String(a.ran).padStart(3)} ${f(a.approvalRate)} ${f(a.revisionRate)} ${f(a.clarificationRate)} ${f(a.declineRate)}  ${String(a.skipped).padStart(6)}`);
  }
  lines.push('', sum.signals.length ? 'Signals:' : `No signals (steps need >= ${sum.minRuns} runs to be judged).`);
  for (const s of sum.signals) lines.push(`  - ${s}`);
  return lines.join('\n');
}

module.exports = { MIN_RUNS, historyFile, closeRun, closeIfFinished, closeAsReplaced, readAll, summarize, formatSummary };
