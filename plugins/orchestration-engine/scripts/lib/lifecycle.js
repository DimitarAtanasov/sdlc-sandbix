'use strict';

// Lifecycle state machine (section 6.3): at every pipeline step the active
// agent evaluates its local state and reports exactly one of three decisions -
//   draft              proceed: the step's artifact is ready
//   ask_clarification  stop and ask the user (missing_info lists the questions)
//   decline            abort: not enough information to proceed safely
// This module is pure state logic (no I/O). Callers persist `run` under the
// store's lock.
//
// Stages run sequentially; steps within one stage may run in any order:
//   spec-eval -> tech-design -> tech-design-eval -> implementation
//     -> (documentation | testing) -> delivery
// `delivery` is not an agent: the conductor records it once verification has
// passed and a PR exists (see markDelivered).

const STAGES = [
  ['spec-eval'],
  ['tech-design'],
  ['tech-design-eval'],
  ['implementation'],
  ['documentation', 'testing'],
  ['delivery'],
];
const STEPS = STAGES.flat();
const AGENT_STEPS = STEPS.filter((s) => s !== 'delivery');
// Steps whose agents report a verdict (approve/revise) on someone else's work.
const REVIEW_STEPS = new Set(['spec-eval', 'tech-design-eval', 'testing']);
// Review steps that need several independent approvals at Level 3.
const MULTI_CYCLE_STEPS = new Set(['spec-eval', 'tech-design-eval']);
// When a review step says "revise", this producer step must be reworked first.
const REWORKS = { 'tech-design-eval': 'tech-design', testing: 'implementation' };
const SKIPPED_AT_LEVEL1 = ['spec-eval', 'tech-design', 'tech-design-eval'];
const DECISIONS = ['draft', 'ask_clarification', 'decline'];
const GENERIC_AGENTS = /^(general-purpose|claude|task)$/i;
const MAX_EVENTS = 50;
const ACTIVE_STATUSES = ['running', 'needs_clarification', 'revise', 'needs_cycle', 'needs_rework'];

const word = (alts) => new RegExp(`(^|[^a-z])(${alts})([^a-z]|$)`);
const RE = {
  designEval: /design.*(eval|review)|(eval|review).*design/,
  design: word('design'),
  spec: word('specs?|specification'),
  impl: word('impl|implement|implementation|implementing'),
  doc: word('docs?|document|documentation|documenting'),
  test: word('tests?|testing'),
};

/** Maps an agent type (or description) to its pipeline step, or null. */
function stepFor(text) {
  const t = String(text || '').toLowerCase();
  if (RE.designEval.test(t)) return 'tech-design-eval';
  if (RE.design.test(t)) return 'tech-design';
  if (RE.spec.test(t)) return 'spec-eval';
  if (RE.impl.test(t)) return 'implementation';
  if (RE.doc.test(t)) return 'documentation';
  if (RE.test.test(t)) return 'testing';
  return null;
}

function isGenericAgent(type) {
  return !type || GENERIC_AGENTS.test(type);
}

/** Resolves the step for an Agent call: subagent_type first; the description only for generic agents. */
function stepForCall({ subagent_type: type, description } = {}) {
  const fromType = stepFor(String(type || '').replace(/^.*:/, ''));
  if (fromType || !isGenericAgent(type)) return fromType;
  return stepFor(description);
}

function stageIndex(step) {
  return STAGES.findIndex((stage) => stage.includes(step));
}

/** Starts a fresh pipeline run from a computed orchestration decision. */
function beginRun(result, config, opts = {}) {
  const { matrix } = result;
  const level = matrix.level;
  const decision = matrix.threeWayDecision;
  const hotfix = Boolean(opts.hotfix);
  const steps = Object.fromEntries(
    STEPS.map((s) => [s, { status: 'pending', cycles: 0, approvals: 0, attempts: 0, revisions: 0, clarifications: 0, questions: [] }])
  );
  if (level === 1 || hotfix) for (const s of SKIPPED_AT_LEVEL1) steps[s].status = 'skipped';

  const halted = decision.decision === 'decline';
  return {
    version: 2,
    startedAt: new Date().toISOString(),
    task: String(result.task || '').slice(0, 200),
    repoRoot: result.repoRoot || null,
    magnitude: result.complexity ? result.complexity.magnitude : null,
    vector: result.complexity ? result.complexity.vector : null,
    level,
    levelName: matrix.levelName,
    hotfix,
    halted,
    haltReason: halted ? decision.reason : null,
    requireClarification: Boolean(decision.forceClarification) && !hotfix,
    clarified: false,
    completed: false,
    policy: {
      minCycles: level === 3 ? config.minEvalCycles : 1,
      maxCycles: config.maxEvalCycles,
      minConfidence: config.minConfidence,
    },
    steps,
    events: [],
    overrides: [],
    verification: null,
    delivery: null,
    stopBlock: null,
  };
}

function firstActiveStep(run) {
  return AGENT_STEPS.find((s) => run.steps[s].status !== 'skipped');
}

function openQuestions(run) {
  return STEPS.filter((s) => run.steps[s].status === 'needs_clarification').flatMap((s) => run.steps[s].questions || []);
}

/** Whether `step` may start now. Returns { allow, reason }. Does not mutate. */
function checkStart(run, step) {
  if (run.halted) {
    return { allow: false, reason: `Pipeline halted (${run.haltReason || 'declined'}). Ask the user for the missing information, or have them override with: sdlc-lifecycle override --reason "<why>".` };
  }
  if (!step) return { allow: true };

  const st = run.steps[step];
  if (st.status === 'skipped') {
    const why = run.hotfix ? 'Hotfix mode skips design/eval.' : `${run.levelName}: design/eval steps are skipped at this complexity level.`;
    return { allow: false, reason: `${why} Proceed directly to implementation.` };
  }
  for (const stage of STAGES.slice(0, stageIndex(step))) {
    for (const prior of stage) {
      const status = run.steps[prior].status;
      if (status !== 'approved' && status !== 'skipped') {
        return { allow: false, reason: `Sequential gating: '${prior}' must be approved before '${step}' (it is currently '${status}').` };
      }
    }
  }
  return { allow: true };
}

/** Marks a step as started. Re-spawning after needs_clarification means the user answered. */
function markStarted(run, step, { generic = false } = {}) {
  if (!step) return run;
  const st = run.steps[step];
  if (st.status === 'needs_clarification') {
    run.clarified = true;
    st.questions = [];
  }
  st.status = 'running';
  st.attempts += 1;
  st.generic = generic;
  return run;
}

/** Policy notes shown to the agent/orchestrator when a step starts. */
function startNotes(run, step) {
  const notes = [];
  if (run.level === 1) notes.push("Level 1: only the 'draft' decision is permitted (ask_clarification and decline are disabled).");
  if (run.hotfix) notes.push('Hotfix: keep the change minimal; testing and verification are mandatory.');
  if (run.requireClarification && !run.clarified && step === firstActiveStep(run)) {
    notes.push("H > 40: this first step MUST end with decision 'ask_clarification' and list the open questions in missing_info.");
  }
  if (MULTI_CYCLE_STEPS.has(step) && run.policy.minCycles > 1) {
    notes.push(`Level 3 isolation loop: '${step}' needs ${run.policy.minCycles} independent approvals (max ${run.policy.maxCycles} cycles); judge the artifact fresh, do not rubber-stamp.`);
  }
  if (REVIEW_STEPS.has(step)) notes.push('Include "verdict":"approve|revise" in your decision block.');
  return notes;
}

function normalizeReport(report = {}) {
  const decision = DECISIONS.includes(report.decision) ? report.decision : null;
  const confidence = typeof report.confidence === 'number' ? report.confidence : null;
  const verdict = ['approve', 'revise'].includes(report.verdict) ? report.verdict : null;
  const missing = Array.isArray(report.missing_info) ? report.missing_info.map(String) : [];
  return { decision, confidence, verdict, missing_info: missing, summary: report.summary ? String(report.summary) : '' };
}

/** A step was (re)approved: everything downstream consumed its old output, so it must run again. */
function invalidateLater(run, step) {
  for (const stage of STAGES.slice(stageIndex(step) + 1)) {
    for (const later of stage) {
      const st = run.steps[later];
      if (['approved', 'revise', 'needs_cycle', 'needs_rework'].includes(st.status)) {
        st.status = 'pending';
        st.approvals = 0;
      }
    }
  }
  run.completed = false;
}

function nextActionAfterApproval(run) {
  const remaining = STEPS.filter((s) => !['approved', 'skipped'].includes(run.steps[s].status));
  if (!remaining.length) {
    run.completed = true;
    return 'done';
  }
  if (remaining.every((s) => s === 'delivery')) return 'deliver';
  const nextStage = STAGES.find((stage) => stage.some((s) => remaining.includes(s) && s !== 'delivery'));
  return `run:${nextStage.filter((s) => remaining.includes(s)).join('|')}`;
}

function pushEvent(run, event) {
  run.events.push({ ...event, at: new Date().toISOString() });
  if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
}

/**
 * Applies an agent's reported decision to the run, enforcing the per-level
 * policy. Returns { status, nextAction, coerced[] }. Mutates `run`.
 */
function recordReport(run, step, rawReport) {
  const report = normalizeReport(rawReport);
  const st = run.steps[step];
  if (!st.attempts) st.attempts = 1; // a manual 'lifecycle record' implies the step ran
  const coerced = [];
  let { decision } = report;

  if (!decision) {
    decision = 'draft';
    coerced.push('No valid decision reported; treated as draft.');
  }
  if (run.level === 1 && decision !== 'draft') {
    coerced.push(`Level 1: '${decision}' is disabled; treated as draft.`);
    decision = 'draft';
  }
  if (run.level > 1 && decision === 'draft' && report.confidence !== null && report.confidence < run.policy.minConfidence) {
    coerced.push(`Confidence ${report.confidence} < ${run.policy.minConfidence}; draft downgraded to ask_clarification.`);
    decision = 'ask_clarification';
  }
  if (decision === 'draft' && run.requireClarification && !run.clarified && step === firstActiveStep(run)) {
    coerced.push('H > 40: first step must ask for clarification; draft downgraded to ask_clarification.');
    decision = 'ask_clarification';
  }

  let nextAction;
  if (decision === 'ask_clarification') {
    st.status = 'needs_clarification';
    st.clarifications += 1;
    st.questions = report.missing_info;
    nextAction = 'ask_user';
  } else if (decision === 'decline') {
    st.status = 'declined';
    run.halted = true;
    run.haltReason = `'${step}' declined: ${report.summary || report.missing_info.join('; ') || 'lack of information'}`;
    nextAction = 'abort';
  } else if (REVIEW_STEPS.has(step) && report.verdict === 'revise') {
    st.cycles += 1;
    st.revisions += 1;
    st.approvals = 0;
    if (st.cycles >= run.policy.maxCycles) {
      // Loop exhausted: a human decides how to proceed; the budget restarts after they answer.
      st.status = 'needs_clarification';
      st.clarifications += 1;
      st.cycles = 0;
      st.questions = [`'${step}' still requests revisions after ${run.policy.maxCycles} cycles${report.summary ? `: ${report.summary}` : ''}. How should we proceed?`];
      coerced.push(`Revision loop exhausted after ${run.policy.maxCycles} cycles; asking the user.`);
      nextAction = 'ask_user';
    } else {
      st.status = 'revise';
      const producer = REWORKS[step];
      if (producer) run.steps[producer].status = 'needs_rework';
      nextAction = `rerun:${producer || step}`;
    }
  } else if (REVIEW_STEPS.has(step)) {
    st.cycles += 1;
    st.approvals += 1;
    const need = MULTI_CYCLE_STEPS.has(step) ? run.policy.minCycles : 1;
    if (st.approvals < need) {
      st.status = 'needs_cycle';
      nextAction = `rerun:${step}`;
    } else {
      st.status = 'approved';
      invalidateLater(run, step);
      nextAction = nextActionAfterApproval(run);
    }
  } else {
    st.status = 'approved';
    invalidateLater(run, step);
    nextAction = nextActionAfterApproval(run);
  }

  st.lastReport = { ...report, decision };
  pushEvent(run, { step, status: st.status, nextAction, coerced });
  return { status: st.status, nextAction, coerced };
}

/** Human override of a halt (decline gate or an agent decline): the pipeline may continue. */
function override(run, reason) {
  if (!run.halted) return { ok: false, reason: 'The run is not halted.' };
  run.overrides.push({ at: new Date().toISOString(), reason: String(reason || ''), was: run.haltReason });
  run.halted = false;
  run.haltReason = null;
  for (const s of STEPS) if (run.steps[s].status === 'declined') run.steps[s].status = 'pending';
  pushEvent(run, { step: null, status: 'override', nextAction: 'resume', coerced: [] });
  return { ok: true };
}

/**
 * Records delivery. Requires every earlier stage approved/skipped and a passing
 * verification of exactly the content being delivered (treeHash must match).
 */
function markDelivered(run, { pr, treeHash, branch } = {}) {
  if (run.halted) return { ok: false, reason: `Pipeline halted: ${run.haltReason}` };
  for (const s of AGENT_STEPS) {
    if (!['approved', 'skipped'].includes(run.steps[s].status)) {
      return { ok: false, reason: `Cannot deliver: '${s}' is '${run.steps[s].status}'.` };
    }
  }
  const v = run.verification;
  if (!v) return { ok: false, reason: 'Cannot deliver: no verification recorded. Run: sdlc-verify run' };
  if (v.treeHash !== treeHash) return { ok: false, reason: 'Cannot deliver: the code changed since it was verified. Re-run: sdlc-verify run' };
  if (!v.passed && v.configured) return { ok: false, reason: 'Cannot deliver: verification failed. Fix it, then re-run: sdlc-verify run' };
  run.steps.delivery.status = 'approved';
  run.steps.delivery.attempts += 1;
  run.delivery = { at: new Date().toISOString(), pr: pr || null, branch: branch || null, unverified: v.configured ? v.manual : ['No automated verification configured (.sdlc/verify.json)'] };
  run.completed = true;
  pushEvent(run, { step: 'delivery', status: 'approved', nextAction: 'done', coerced: [] });
  return { ok: true };
}

/** Parses the last <decision>{...}</decision> block from an agent's final message. */
function parseDecisionBlock(text) {
  const matches = [...String(text || '').matchAll(/<decision>\s*([\s\S]*?)\s*<\/decision>/gi)];
  if (!matches.length) return null;
  let body = matches[matches.length - 1][1].trim();
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function lastEventFor(run, step) {
  for (let i = run.events.length - 1; i >= 0; i--) if (run.events[i].step === step) return run.events[i];
  return null;
}

function summarize(run) {
  const flags = [run.hotfix ? 'HOTFIX' : null, run.halted ? `HALTED: ${run.haltReason}` : run.completed ? 'COMPLETE' : null].filter(Boolean);
  const lines = [`${run.levelName}${flags.length ? ' - ' + flags.join(' - ') : ''}`];
  for (const stage of STAGES) {
    for (const s of stage) {
      const st = run.steps[s];
      lines.push(`  ${s.padEnd(17)} ${st.status}${st.cycles ? ` (cycles=${st.cycles})` : ''}`);
    }
  }
  const qs = openQuestions(run);
  if (qs.length) lines.push(`Open questions: ${qs.join(' | ')}`);
  if (run.verification) {
    const v = run.verification;
    lines.push(`Verification: ${v.configured ? (v.passed ? 'passed' : 'FAILED') : 'not configured'} at ${v.at}${v.manual && v.manual.length ? `; manual checks: ${v.manual.join('; ')}` : ''}`);
  }
  if (run.delivery) lines.push(`Delivered: ${run.delivery.pr || run.delivery.branch || 'yes'}`);
  const ev = run.events[run.events.length - 1];
  if (ev) lines.push(`Last event: ${ev.step || '-'} -> ${ev.status}; next: ${ev.nextAction}`);
  return lines.join('\n');
}

module.exports = {
  STAGES, STEPS, AGENT_STEPS, REVIEW_STEPS, MULTI_CYCLE_STEPS, ACTIVE_STATUSES, DECISIONS,
  stepFor, stepForCall, isGenericAgent, beginRun, checkStart, markStarted, startNotes,
  recordReport, parseDecisionBlock, summarize, firstActiveStep, openQuestions, override,
  markDelivered, lastEventFor, pushEvent,
  EVAL_STEPS: MULTI_CYCLE_STEPS, // back-compat alias used by history signals
};
