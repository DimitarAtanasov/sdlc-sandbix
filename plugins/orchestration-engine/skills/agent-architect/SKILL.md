---
name: agent-architect
description: Design a new AI agent team for a workflow, or audit the existing SDLC pipeline agents (is each one necessary, should any be merged, made conditional or removed?). Grounds the answer in the agents actually installed and in recorded pipeline run history instead of opinion. Use when the user asks to design agents, add/remove/merge a pipeline agent, or whether the pipeline's agents are all needed.
---

# Agent Architect

Two modes. **Audit** (default when pipeline agents already exist): judge the current team.
**Design** (a new workflow): propose the smallest team that works. Either way, ground every
claim in something you actually read or ran, and never invent tools, agents or numbers.

## 0. Ground yourself first (no guessing)

1. List the agents that really exist. Glob `plugins/*/agents/*.md`, `.claude/agents/*.md`, and
   `~/.claude/plugins/cache/**/agents/*.md`; read each one's frontmatter (tools, model) and its
   decision contract. Say plainly which locations you could not see.
2. Read the recorded run evidence:
   ```
   OE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/history.js" summary
   OE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/history.js" list --limit 10
   ```
   It reports, per step, runs, approval, revision, clarification and decline rates, plus
   signals such as "rubber-stamp candidate". A step needs at least 5 runs to be judged. With
   fewer, say "no evidence yet" - do not extrapolate from one or two runs.
3. Note the orchestration engine's current levels and config (see its README) so advice
   matches how work is actually routed (Level 1 already skips design/eval).

## 1. Ask before designing

If any of these is unknown and the history cannot answer it, ask in **one message** (max 5
numbered questions) and wait: the outcome and how success is measured; the real bottleneck;
what must stay a human decision; which tools/models/budget are actually available; the
volume and risk of the work. Do not design around guessed context.

## 2. Principles

- **Deterministic first.** If a script, hook or gate can do a step, it should not be an agent.
  (Complexity scoring, sequencing, model selection and policy are already code in this build.)
- **Smallest team.** Every agent must earn its place; prefer 3-5 per workflow, and justify more.
- **Explicit handoffs.** Each handoff is a named artifact (path) plus a decision block. If you
  cannot name what the next agent reads, the boundary is wrong.
- **Humans stay in control** of ambiguous requirements, risky or irreversible actions, and the
  final merge. Say where the checkpoints are.
- **Least privilege.** Evaluators are read-only. Give each agent only the tools it needs.

## 3. Necessity test (per agent)

1. Could deterministic code do this? 2. Does the next step consume its output? 3. Does it ever
change the outcome? Use the history: first-time-approve on every run with no revisions or
questions means it adds cost without catching anything. 4. Is it a merge candidate with its
neighbour (for example spec-eval and tech-design at Level 2)? 5. What does it cost (model tier,
token cap) at the levels where it runs?

Verdict per agent: **keep**, **make conditional** (for example only at Level 3), **merge into
X**, or **remove**. Cite the evidence ("n=7, approved first time 7/7") and what result would
change the verdict. With no evidence, the verdict is "keep, revisit after N runs".

## 4. Design mode specifics

For each proposed agent give: name and purpose, inputs, output artifact, tools, model tier,
decision contract, failure modes and guardrail, success metric. Add a handoff table and the
human checkpoints. Propose the blueprint first; write full prompts only for the agents the
user approves, one at a time - not all at once.

## 5. Output (compact)

1. **Summary** (3 lines max). 2. **Verdicts / team table.** 3. **Handoffs.** 4. **Human
checkpoints and guardrails.** 5. **How to measure it** (which history signals to watch, and
the sample size needed). 6. **Assumptions and unknowns.** 7. **One recommended next step.**
Offer prompts, a rollout plan or an optimization pass only if asked.

## 6. Final checks before you answer

- Is each agent truly necessary, and is that backed by evidence rather than taste?
- Are all handoffs explicit and clean?
- Where can duplication or hallucination happen, and what stops it?
- What still needs human review or approval?
- How will the user know after deployment whether it worked?

## Making the change

Do not edit agents until the user approves the verdicts. Then edit the agent files, run
`npm test` in the orchestration-engine plugin, and run `claude plugin validate --strict` on
the changed plugin before committing.
