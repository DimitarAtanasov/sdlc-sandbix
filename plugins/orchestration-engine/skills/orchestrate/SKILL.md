---
name: orchestrate
description: Run the AI SDLC Automated Orchestration Engine on a task before delegating to the spec/eval, tech-design, implementation, documentation, or testing agents. Computes the Complexity Vector [S, D, H] and Magnitude M from local repo/git state, returns the pipeline strategy, model tier, token cap and 3-way decision (draft / ask clarification / decline), and starts a gated pipeline run. Use whenever the user describes new SDLC work, asks "how complex is this", or asks you to route/plan a task before implementing it.
---

# Orchestration Engine

Section 6 of the AI SDLC framework: every task gets a Complexity Vector and an
execution-matrix decision computed from local repo/git state *before* any
pipeline agent runs. The analysis is pure static analysis - no LLM call.

## 1. Compute the decision

Pass the user's task description verbatim (the wording feeds the H-factor
spec-similarity check):

```
OE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/compute-complexity.js" "<task description>"
```

Add `--files a.cs,b.cs` if the user named target files, `--json` for the raw
vector. This also starts a fresh **pipeline run** for this session and saves
the decision; the plugin's hooks then enforce it on every pipeline `Agent` call.

## 2. Act on the level

| Level | What to do |
|---|---|
| **1** (M < 15) | Skip spec-eval, tech-design, tech-design-eval (the gate denies them). Go straight to `implementation`, then `documentation` / `testing`. Only `draft` is allowed. |
| **2** (15-70) | Full sequential pipeline. If the decision is `ASK_CLARIFICATION` (H > 40) the first step is forced to ask the user; relay its questions, then re-run that step. |
| **3** (> 70) | If `DECLINE` (D above the ceiling) the gate halts the pipeline: tell the user what information is missing and stop. Otherwise run the isolation loop: spec-eval and tech-design-eval each need multiple independent cycles. |

Pipeline order: `spec-eval -> tech-design -> tech-design-eval -> implementation -> (documentation | testing)`.
A step may only start when every earlier stage is approved.

## 3. Run the agents

Invoke each pipeline agent with the `Agent` tool (agents from the `sdlc-agents`
plugin, or your own). Pass `model` from the decision; the gate fills it in if
you omit it. Each agent ends its reply with a decision block:

```
<decision>{"decision":"draft|ask_clarification|decline","confidence":0.8,"verdict":"approve|revise","missing_info":[],"summary":"..."}</decision>
```

The `SubagentStop` hook records it and the `PostToolUse` hook tells you the
next action after every agent returns:

- **ask_user** - ask the user the listed questions, then re-run the same step
  (re-running after a clarification marks it answered).
- **rerun:\<step\>** - an eval requested revisions or another isolation cycle is required.
- **run:\<steps\>** - proceed to the next stage.
- **abort** - stop and explain `haltReason` to the user.
- **done** - summarize the results.

The engine can downgrade a reported decision (Level 1 disables ask/decline;
a low-confidence `draft` becomes `ask_clarification`); the hook message says so.

## 4. Inspect or repair the run

```
OE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle.js" status
OE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle.js" clarified      # user answered without a re-run
OE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/lifecycle.js" record <step> --decision draft --verdict approve
```

`record` is the manual fallback when an agent can't emit its decision block.

## Notes

- Prefers real `git diff`/untracked-file state over the text-length estimate;
  re-run `/orchestrate` once code exists for a precise S, D and churn-based H.
- H uses TF-cosine similarity against `specs/**/*.md` (or `docs/specs/`). A spec
  sharing almost no vocabulary with the task is treated as unrelated (neutral
  0.5 distance), not as evidence of ambiguity.
- A decision is valid for `decisionTtlHours` (default 6); after that the gate
  stays out of the way (normal permission flow, with a reminder) until you run
  `/orchestrate` again.
- State is per session (`CLAUDE_SESSION_ID`, exported by the SessionStart hook).
- Token caps are advisory: Claude Code has no per-subagent hard token limit,
  so the cap is surfaced to the agent rather than metered.
