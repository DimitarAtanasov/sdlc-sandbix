# orchestration-engine

The Automated Orchestration Engine for the AI SDLC framework
(`spec-eval -> tech-design -> tech-design-eval -> implementation -> documentation | testing`).
It runs deterministic static analysis on a task before any LLM is invoked, routes it
through the 3-level execution matrix, and then **enforces** the 3-way lifecycle
(draft / ask clarification / decline) on the pipeline agents that follow.

## 1. Complexity Vector and Matrix

`C = [S, D, H]`, computed from local repo/git state (no LLM):

- `S` = `1.5*deltaLines + 10*fileCount`. Uses the real `git diff` plus untracked files once
  code exists; before that, `deltaLines ~ words/3` (min 1, max 500) and files named in the task.
- `D` = sum over target files of inbound references (`git grep` hits on the file's basename) and
  outbound dependencies (import/using/require/`$ref` lines).
- `H` = `churnWeight*churn30d + specDistanceWeight*cosineDistanceToSpecs` (defaults 2 and 50).
  The distance is a TF-cosine against `specs/**/*.md` (or `docs/specs/`). A spec sharing almost
  no vocabulary with the task is *unrelated*, not evidence of ambiguity, so it scores the neutral
  0.5, the same as having no specs. (Without this every small task that no spec mentioned
  scored `H=50` and could not reach Level 1.)

`M = sqrt(0.4*S^2 + 0.4*D^2 + 0.2*H^2)`:

| Level | M | Pipeline | Model tier | Token cap | 3-way default |
|---|---|---|---|---|---|
| 1 Micro-Task | < 15 | design/eval steps skipped | Tier 3 (`haiku`) | 5,000 | `draft` only (ask/decline disabled) |
| 2 Standard | 15-70 | full sequential pipeline | Tier 2 (`sonnet`) | dynamic 50k-150k | `ask_clarification` when `H > 40` |
| 3 Macro Arch | > 70 | isolation loop (multi-cycle evals) | Tier 1 (`opus`) | max context | decline when `D > declineDHardCeiling` |

Tiers map to Claude models by default and can be changed in user config. Token caps are advisory:
Claude Code has no per-subagent hard limit, so the cap is surfaced to the agent, not metered.

## 2. Lifecycle state machine (3-way decisioning)

Every pipeline agent ends its reply with
`<decision>{"decision":"draft|ask_clarification|decline","confidence":0.8,"verdict":"approve|revise","missing_info":[],"summary":"..."}</decision>`.

- `draft` - proceed; the step is approved.
- `ask_clarification` - the step waits; the orchestrator asks the user `missing_info`, then re-runs the step (re-running marks it answered).
- `decline` - the whole run halts with the reason.

The engine applies policy on top of what the agent reports:

- Level 1: `ask_clarification` and `decline` are coerced to `draft`.
- Levels 2-3: a `draft` with `confidence < minConfidence` (0.5) is downgraded to `ask_clarification`.
- Level 2 with `H > 40`: the first step is forced to ask once.
- Level 3 `D > ceiling`: the run starts halted (decline gate).
- Eval steps (`spec-eval`, `tech-design-eval`): `verdict: revise` sends `tech-design` back for rework and
  re-evaluates it; Level 3 requires `minEvalCycles` (2) independent approvals; after `maxEvalCycles` (4) of
  revisions the run is declined (loop exhausted).
- Sequential gating: a step cannot start until all earlier stages are approved or skipped.

Hooks (`hooks/hooks.json`):

| Hook | Script | Job |
|---|---|---|
| `SessionStart` | `session-start.js` | exports `CLAUDE_SESSION_ID`, `OE_PLUGIN_DATA`, `OE_OPTION_*` to the Bash tool |
| `PreToolUse` (Agent) | `enforce-gate.js` | deny halted/skipped/out-of-order steps; fill in the tier's model |
| `SubagentStop` | `record-step.js` | parse and apply the decision block (blocks once if it is missing) |
| `PostToolUse` (Agent) | `post-agent.js` | tell the orchestrator the next action |

State is per session under `${CLAUDE_PLUGIN_DATA}/sessions/<session-id>/{decision,run}.json`.

## 3. Use

```
/orchestrate Add a u_priority_override field to the NeedIt scripted REST API and validate it server-side
/pipeline-status
```

CLI (the plugin's `bin/` is on `PATH`): `orchestrate --json "<task>"`,
`node scripts/lifecycle.js status|clarified|record <step> ...|reset`.

Pair it with the `sdlc-agents` plugin, or point `sdlcAgentPattern` at your own agents. Agents whose
names contain `spec`, `design`, `design`+`eval`, `impl`, `doc`, `test` are mapped to the matching step.

## 4. Config (plugin user config)

`tier1Model`/`tier2Model`/`tier3Model`, `declineDHardCeiling` (60), `decisionTtlHours` (6),
`sdlcAgentPattern`, `churnWeight` (2), `specDistanceWeight` (50), `minEvalCycles` (2),
`maxEvalCycles` (4), `minConfidence` (0.5), `requireDecisionBlock` (true).

## 5. Tests

`npm test` in this directory (Node >= 20, no dependencies): 42 tests covering the matrix, the cosine
check, the state machine, and the hooks/CLI end to end against temp git repos.

## Known limits

- `D`'s inbound count is a basename text search, not a symbol-level graph across .NET/Kafka/SN.
- Cosine similarity is lexical; an embedding model would catch paraphrases.
- One active run per session; `/orchestrate` starts a new one.
- A decision is valid for `decisionTtlHours`; afterwards the gate only reminds you to re-run `/orchestrate`.
