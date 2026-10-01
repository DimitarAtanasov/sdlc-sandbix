---
name: orchestrate
description: Run the AI SDLC Automated Orchestration Engine on a task before delegating to the spec/eval, tech-design, implementation, documentation, or testing agents. Computes the Complexity Vector [S, D, H] and Magnitude M from local repo/git state, then returns the pipeline strategy, model tier, token cap, and 3-way decision (draft / ask clarification / decline). Use whenever the user describes new SDLC work, asks "how complex is this", or asks you to route/plan a task before implementing it.
---

# Orchestration Engine

This skill is the deterministic gate described in section 6 of the AI SDLC
framework: every task gets a Complexity Vector and an execution-matrix
decision computed from local repo/git state *before* any pipeline agent is
invoked. It never calls an LLM itself - it is pure static analysis.

## Steps

1. Take the user's task description verbatim (don't paraphrase it - the
   wording feeds the H-factor spec-similarity check).
2. Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/compute-complexity.js" "<task description>"
   ```
   Pass `--files a.cs,b.cs` if the user already named specific target files,
   and `--json` if you need the raw vector for further reasoning.
3. The script prints the Complexity Vector (S, D, H), Magnitude (M), and the
   resulting Level / pipeline strategy / model tier / token cap / 3-way
   decision. It also persists this decision to
   `${CLAUDE_PLUGIN_DATA}/last-decision.json`, which the plugin's
   `enforce-gate.js` PreToolUse hook reads to automatically gate and
   route the next `Agent` tool calls you make for this task (it will deny
   skipped steps, deny on a Decline Gate, and auto-fill the mandated model
   tier when you don't set one explicitly).
4. Report the decision to the user in plain language, then act on it:
   - **Level 1 (M < 15, decision=draft)**: skip the spec-eval and
     tech-design/tech-design-eval agents. Go straight to the
     implementation agent (Tier 3 model, 5,000 token cap), then
     documentation/testing as usual.
   - **Level 2 (15 <= M <= 70)**: run the full pipeline in order
     (spec-eval -> tech-design -> tech-design-eval -> implementation ->
     documentation -> testing), Tier 2 model, dynamic token cap. If the
     decision came back `ask_clarification` (H > 40), ask the user the
     clarifying questions before invoking any pipeline agent.
   - **Level 3 (M > 70)**: if the decision is `decline`, tell the user why
     (D exceeded the hard ceiling - the task is too architecturally
     coupled to proceed without more information) and ask for the missing
     context instead of invoking any agent. Otherwise, run the pipeline as
     an isolation loop (forced multi-cycle spec evaluation) with the Tier 1
     model and the full context window.
5. When you invoke a pipeline agent via the `Agent` tool, pass
   `model: "<modelTier.model>"` from the decision unless the task clearly
   needs an override - the enforcement hook will fill it in automatically
   if you omit it, but being explicit keeps the transcript readable.
6. If the user pushes back on the computed level (e.g. "this is actually
   bigger than that"), you can re-run the script with `--files` listing the
   files you now believe are in scope, or just proceed at the higher level
   and say why - the engine is a default, not a hard override of your
   judgment, except for the Level 3 Decline Gate and Level 1 skip rules,
   which the hook enforces on pipeline-agent calls regardless.

## Notes

- The engine prefers real `git diff`/untracked-file state when it exists
  (you've already started editing) over the text-length heuristic used for
  a task that's still just a description. Re-run `/orchestrate` once code
  changes exist to get a precise S/D and a churn-based H instead of the
  estimate.
- The H factor's "Cosine Distance to Specs" is a deterministic TF-cosine
  similarity against `specs/**/*.md` (or `docs/specs/**/*.md`) in this repo
  - no embeddings model involved. If no specs directory exists, it falls
  back to a neutral 0.5 distance.
- A computed decision is only valid for `decisionTtlHours` (default 6,
  configurable in the plugin's user config) before the enforcement hook
  treats it as stale and defers to normal permission flow.
