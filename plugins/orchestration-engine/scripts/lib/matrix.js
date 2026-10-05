'use strict';

const { DEFAULTS } = require('./config');

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function levelFor(M) {
  if (M < 15) return 1;
  if (M <= 70) return 2;
  return 3;
}

function tokenCapFor(level, M) {
  if (level === 1) return { capTokens: 5000, description: '5,000 token hard cap' };
  if (level === 2) {
    const capTokens = Math.round(50_000 + clamp((M - 15) / (70 - 15), 0, 1) * (150_000 - 50_000));
    return { capTokens, description: `Dynamic: 50k-150k tokens (~${capTokens.toLocaleString()} at M=${M.toFixed(1)})` };
  }
  return { capTokens: null, description: 'Max context window allocation' };
}

function pipelineStrategyFor(level) {
  if (level === 1) return 'Skip Design/Eval steps. Immediate execution.';
  if (level === 2) return 'Full pipeline enforced. Sequential agent gating.';
  return 'Isolation loop. Forced multi-cycle spec evaluation.';
}

function modelTierFor(level, config) {
  if (level === 1) return { tier: 'Tier 3 (Fast/Cheap)', model: config.tier3Model };
  if (level === 2) return { tier: 'Tier 2 (Balanced)', model: config.tier2Model };
  return { tier: 'Tier 1 (Deep Reasoning)', model: config.tier1Model };
}

/**
 * The 3-way lifecycle decision for THIS specific task, applying the
 * per-level default rule from section 6.2/6.3 of the spec.
 */
function threeWayDecisionFor(level, vector, config) {
  if (level === 1) {
    return {
      decision: 'draft',
      reason: 'Level 1 Micro-Task: Draft is auto-approved. Ask-clarification and Decline are disabled.',
      skipSteps: ['spec-eval', 'tech-design', 'tech-design-eval'],
    };
  }
  if (level === 2) {
    if (vector.H > 40) {
      return {
        decision: 'ask_clarification',
        reason: `Level 2 Standard: H=${vector.H.toFixed(1)} > 40, the Evaluate Loop yields to Ask Clarification.`,
        skipSteps: [],
        forceClarification: true,
      };
    }
    return {
      decision: 'draft',
      reason: `Level 2 Standard: H=${vector.H.toFixed(1)} <= 40, proceeds through the full Evaluate Loop.`,
      skipSteps: [],
    };
  }
  // level === 3
  if (vector.D > config.declineDHardCeiling) {
    return {
      decision: 'decline',
      reason: `Level 3 Macro Arch: D=${vector.D.toFixed(1)} > hard ceiling ${config.declineDHardCeiling}. Decline Gate aborts with "lack of info".`,
      skipSteps: ['all'],
    };
  }
  return {
    decision: 'draft',
    reason: `Level 3 Macro Arch: D=${vector.D.toFixed(1)} within ceiling ${config.declineDHardCeiling}. Forced multi-cycle isolation loop proceeds.`,
    skipSteps: [],
  };
}

/**
 * Maps a Complexity Vector/Magnitude to the 3-level self-deciding execution
 * matrix from section 6.2 of the orchestration engine spec.
 */
function decideExecutionMatrix({ vector, magnitude }, userConfig = {}) {
  const config = { ...DEFAULTS, ...userConfig };
  const level = levelFor(magnitude);
  const levelName = level === 1 ? 'Level 1: Micro-Task' : level === 2 ? 'Level 2: Standard' : 'Level 3: Macro Arch';

  return {
    level,
    levelName,
    magnitudeRange: level === 1 ? 'M < 15' : level === 2 ? '15 <= M <= 70' : 'M > 70',
    pipelineStrategy: pipelineStrategyFor(level),
    modelTier: modelTierFor(level, config),
    tokenCap: tokenCapFor(level, magnitude),
    threeWayDecision: threeWayDecisionFor(level, vector, config),
    config,
  };
}

module.exports = { decideExecutionMatrix, levelFor, DEFAULTS };
