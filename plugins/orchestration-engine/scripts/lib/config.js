'use strict';

// Single source of truth for plugin user config (mirrors userConfig in
// .claude-plugin/plugin.json). Claude Code exports each option to plugin
// subprocesses as CLAUDE_PLUGIN_OPTION_<KEY>; we accept both the key as
// written and its upper-cased form.
const SCHEMA = {
  tier1Model: { type: 'string', default: 'opus' },
  tier2Model: { type: 'string', default: 'sonnet' },
  tier3Model: { type: 'string', default: 'haiku' },
  declineDHardCeiling: { type: 'number', default: 60 },
  decisionTtlHours: { type: 'number', default: 6 },
  sdlcAgentPattern: { type: 'string', default: 'spec|eval|design|implement|document|doc|test' },
  churnWeight: { type: 'number', default: 2 },
  specDistanceWeight: { type: 'number', default: 50 },
  minEvalCycles: { type: 'number', default: 2 },
  maxEvalCycles: { type: 'number', default: 4 },
  minConfidence: { type: 'number', default: 0.5 },
  requireDecisionBlock: { type: 'boolean', default: true },
  injectLessons: { type: 'boolean', default: true },
};

const DEFAULTS = Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, v.default]));

function coerce(raw, type, fallback) {
  if (raw === undefined || raw === '') return fallback;
  if (type === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  if (type === 'boolean') return !/^(false|0|no|off)$/i.test(String(raw).trim());
  return String(raw);
}

function load(env = process.env, overrides = {}) {
  const config = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    const raw =
      env[`CLAUDE_PLUGIN_OPTION_${key}`] ??
      env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] ??
      env[`OE_OPTION_${key}`] ?? // mirrored into the Bash tool by session-start.js
      env[`OE_OPTION_${key.toUpperCase()}`];
    config[key] = coerce(raw, spec.type, spec.default);
  }
  return { ...config, ...overrides };
}

module.exports = { SCHEMA, DEFAULTS, load };
