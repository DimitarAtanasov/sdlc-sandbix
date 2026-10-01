'use strict';

// Lifecycle state machine (section 6.3): at every pipeline step the active
// agent evaluates its local state and reports exactly one of three decisions -
//   draft              proceed: the step's artifact is ready
//   ask_clarification  stop and ask the user (missing_info lists the questions)
//   decline            abort: not enough information to proceed safely
// This module is pure state logic (no I/O). The hooks/CLI persist `run`.
//
// Pipeline stages run sequentially; steps in one stage may run in any order:
//   spec-eval -> tech-design -> tech-design-eval -> implementation
//     -> (documentation | testing)

const STAGES = [
  ['spec-eval'],
  ['tech-design'],
  ['tech-design-eval'],
  ['implementation'],
  ['documentation', 'testing'],
];
const STEPS = STAGES.flat();
const EVAL_STEPS = new Set(['spec-eval', 'tech-design-eval']);
// When an eval step asks for revisions, this step must be reworked first.
const PRODUCER_OF = { 'tech-design-eval': 'tech-design' };
const LEVEL1_SKIPPED = ['spec-eval', 'tech-design', 'tech-design-eval'];
const DECISIONS = ['draft', 'ask_clarification', 'decline'];
const GENERIC_AGENTS = /^(general-purpose|claude|task)$/i;

/** Maps an agent type (or description) to its pipeline step, or null. */
function stepFor(text) {
  const t = String(text || '').toLowerCase();
  if (/design.*(eval|review)|(eval|review).*design/.test(t)) return 'tech-design-eval';
  if (/(^|[^a-z])design/.test(t)) return 'tech-design';
  if (/(^|[^a-z])spec/.test(t)) return 'spec-eval';
  if (/(^|[^a-z])impl/.test(t)) return 'implementation';
  if (/(^|[^a-z])doc/.test(t)) return 'documentation';
  if (/(^|[^a-z])test/.test(t)) return 'testing';
  return null;
}

/** Resolves the step for an Agent tool call: subagent_type first, description only for generic agents. */
function stepForCall({ subagent_type: type, description } = {}) {
  const fromType = stepFor(type);
  if (fromType || (type && !GENERIC_AGENTS.test(type))) return fromType;
  return stepFor(description);
}

function stageIndex(step) {
  return STAGES.findIndex((stage) => stage.includes(step));
}

/** Starts a fresh pipeline run from a computed orchestration decision. */
function beginRun(result, config) {
  const { matrix } = result;
  const level = matrix.level;
  const decision = matrix.threeWayDecision;
  const steps = Object.fromEntries(
    STEPS.map((s) => [s, { status: 'pending', cycles: 0, attempts: 0 }])
  );
  if (level === 1) for (const s of LEVEL1_SKIPPED) steps[s].status = 'skipped';

  const halted = decision.decision === 'decline';
  return {
    version: 1,
    startedAt: new Date().toISOString(),
    level,
    levelName: matrix.levelName,
    halted,
    haltReason: halted ? decision.reason : null,
    requireClarification: Boolean(decision.forceClarification),
    clarified: false,
    pendingQuestions: [],
    completed: false,
    policy: {
      minCycles: level === 3 ? config.minEvalCycles : 1,
      maxCycles: config.maxEvalCycles,
      minConfidence: config.minConfidence,
    },
    steps,
    lastEvent: null,
  };
}

function firstActiveStep(run) {
  return STEPS.find((s) => run.steps[s].status !== 'skipped');
}

/** Whether `step` may start now. Returns { allow, reason }. Does not mutate. */
function checkStart(run, step) {
  if (run.halted) {
    return { allow: false, reason: `Pipeline halted (${run.haltReason || 'declined'}). Ask the user for the missing information instead of proceeding.` };
  }
  if (!step) return { allow: true };

  const st = run.steps[step];
  if (st.status === 'skipped') {
    return { allow: false, reason: `${run.levelName}: Design/Eval steps are skipped at this complexity level. Proceed directly to implementation.` };
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
function markStarted(run, step) {
  if (!step) return run;
  const st = run.steps[step];
  if (st.status === 'needs_clarification') {
    run.clarified = true;
    run.pendingQuestions = [];
  }
  st.status = 'running';
  st.attempts += 1;
  return run;
}

/** Policy notes shown to the agent/orchestrator when a step starts. */
function startNotes(run, step) {
  const notes = [];
  if (run.level === 1) notes.push("Level 1: only the 'draft' decision is permitted (ask_clarification and decline are disabled).");
  if (run.requireClarification && !run.clarified && step === firstActiveStep(run)) {
    notes.push("H > 40: this first step MUST end with decision 'ask_clarification' and list the open questions in missing_info.");
  }
  if (EVAL_STEPS.has(step) && run.policy.minCycles > 1) {
    notes.push(`Level 3 isolation loop: '${step}' needs ${run.policy.minCycles} independent evaluation cycles (max ${run.policy.maxCycles}); judge the artifact fresh, do not rubber-stamp.`);
  }
  return notes;
}

function normalizeReport(report = {}) {
  const decision = DECISIONS.includes(report.decision) ? report.decision : null;
  const confidence = typeof report.confidence === 'number' ? report.confidence : null;
  const verdict = ['approve', 'revise'].includes(report.verdict) ? report.verdict : null;
  const missing = Array.isArray(report.missing_info) ? report.missing_info.map(String) : [];
  return { decision, confidence, verdict, missing_info: missing, summary: report.summary ? String(report.summary) : '' };
}

function nextActionAfterApproval(run) {
  const remaining = STEPS.filter((s) => !['approved', 'skipped'].includes(run.steps[s].status));
  if (!remaining.length) {
    run.completed = true;
    return 'done';
  }
  const nextStage = STAGES.find((stage) => stage.some((s) => remaining.includes(s)));
  return `run:${nextStage.filter((s) => remaining.includes(s)).join('|')}`;
}

/**
 * Applies an agent's reported decision to the run, enforcing the per-level
 * policy. Returns { status, nextAction, coerced[] }. Mutates `run`.
 */
function recordReport(run, step, rawReport) {
  const report = normalizeReport(rawReport);
  const st = run.steps[step];
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
    coerced.push("H > 40: first step must ask for clarification; draft downgraded to ask_clarification.");
    decision = 'ask_clarification';
  }

  let nextAction;
  if (decision === 'ask_clarification') {
    st.status = 'needs_clarification';
    run.pendingQuestions = report.missing_info;
    nextAction = 'ask_user';
  } else if (decision === 'decline') {
    st.status = 'declined';
    run.halted = true;
    run.haltReason = `'${step}' declined: ${report.summary || report.missing_info.join('; ') || 'lack of information'}`;
    nextAction = 'abort';
  } else if (EVAL_STEPS.has(step)) {
    st.cycles += 1;
    if (report.verdict === 'revise') {
      if (st.cycles >= run.policy.maxCycles) {
        st.status = 'declined';
        run.halted = true;
        run.haltReason = `'${step}' still requesting revisions after ${st.cycles} cycles (isolation loop exhausted).`;
        nextAction = 'abort';
      } else {
        st.status = 'revise';
        const producer = PRODUCER_OF[step];
        if (producer) run.steps[producer].status = 'needs_rework';
        nextAction = `rerun:${producer || step}`;
      }
    } else if (st.cycles < run.policy.minCycles) {
      st.status = 'needs_cycle';
      nextAction = `rerun:${step}`;
    } else {
      st.status = 'approved';
      nextAction = nextActionAfterApproval(run);
    }
  } else {
    st.status = 'approved';
    // A reworked producer must be re-evaluated by its eval step.
    for (const [evalStep, producer] of Object.entries(PRODUCER_OF)) {
      if (producer === step && run.steps[evalStep].status !== 'skipped') run.steps[evalStep].status = 'pending';
    }
    nextAction = nextActionAfterApproval(run);
  }

  st.lastReport = { ...report, decision };
  run.lastEvent = { step, status: st.status, nextAction, coerced, at: new Date().toISOString() };
  return { status: st.status, nextAction, coerced };
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

function summarize(run) {
  const lines = [`${run.levelName}${run.halted ? ' - HALTED: ' + run.haltReason : run.completed ? ' - COMPLETE' : ''}`];
  for (const stage of STAGES) {
    for (const s of stage) {
      const st = run.steps[s];
      lines.push(`  ${s.padEnd(17)} ${st.status}${st.cycles ? ` (cycles=${st.cycles})` : ''}`);
    }
  }
  if (run.pendingQuestions.length) lines.push(`Open questions: ${run.pendingQuestions.join(' | ')}`);
  if (run.lastEvent) lines.push(`Last event: ${run.lastEvent.step} -> ${run.lastEvent.status}; next: ${run.lastEvent.nextAction}`);
  return lines.join('\n');
}

module.exports = {
  STAGES, STEPS, EVAL_STEPS, DECISIONS,
  stepFor, stepForCall, beginRun, checkStart, markStarted, startNotes,
  recordReport, parseDecisionBlock, summarize, firstActiveStep,
};
