---
name: sdlc
description: Run the full AI SDLC for a task end to end - intake, complexity routing, gated pipeline agents (spec, design, design review, implementation, documentation, testing), deterministic verification, delivery (branch + draft PR) and a short retro. Use for any request to build, change or fix something in a repo. Add "hotfix" for urgent production fixes.
---

# /sdlc - the conductor

You are conducting the pipeline, not doing the work yourself: the agents do the
work, the engine's hooks enforce the rules, and the user makes the human decisions.
Keep every message to the user short - they are often on a phone.

## 0. Preconditions (say something only if one fails)

- The working directory is a git repo.
- The pipeline agents exist (`sdlc-agents:spec-eval-agent`, `tech-design-agent`,
  `tech-design-eval-agent`, `implementation-agent`, `documentation-agent`,
  `testing-agent`). If not, tell the user to install `sdlc-agents@sdlc-sandbix`.
- `.sdlc/verify.json` exists or a test command can be autodetected. If neither,
  say once that the result will be reported as **unverified** and offer `/sdlc-setup`.
  Do not block on it.

## 1. Intake

Restate the task in one or two sentences. If the goal, acceptance criteria or
constraints are unclear, ask up to 5 numbered questions in **one** message and wait.
Do not ask what you can read from the repo or from `specs/`. If the user says
hotfix, urgent or production is down, use hotfix mode (confirm in one line).

## 2. Route

```
orchestrate "<task description verbatim>"            # add --hotfix for hotfixes
```

Report in three lines: level and why, model tier, and the 3-way decision. If the
decision is **DECLINE** (D above the ceiling) stop: say what information would make
it safe. Only run `sdlc-lifecycle override --reason "<the user's reason>"` if the
**user** gives you a reason; never override on your own.

## 3. Pipeline

Order: `spec-eval -> tech-design -> tech-design-eval -> implementation -> (documentation | testing)`.
Level 1 and hotfixes skip the first three. Spawn each step with the `Agent` tool.
In the prompt give: the task, the paths of the artifacts it must read, and - for
rework - the exact findings it must address. Pass `model` from the routing decision.
`documentation` and `testing` are independent: spawn both in one message.

After every agent returns, the hooks tell you the next action; follow it:

- `ask_user` - ask the open questions in one message, wait, then re-run **the same step** with the answers in its prompt.
- `rerun:<step>` - an eval asked for revisions (or Level 3 needs another independent cycle). Re-run it with the findings.
- `run:<steps>` - start the next stage.
- `deliver` - go to section 4.
- `abort` - stop and explain the halt reason. The user may override with a reason.

If a hook denies a call, read the reason and do what it says; do not retry the same call.
If an agent ended without a decision block, record it yourself:
`sdlc-lifecycle record <step> --decision draft|ask_clarification|decline [--verdict approve|revise]`.
Check progress any time with `sdlc-lifecycle status`.

## 4. Verify (deterministic - do not skip, do not argue with it)

```
sdlc-verify run
```

It runs the repo's declared checks and records evidence for exactly this code.
If checks fail, send the failures to `implementation-agent` (or re-run `testing-agent`
so the engine reworks implementation), then verify again. Never weaken, skip or
delete a check to make it pass. If nothing is configured, or some checks are
manual (for example a ServiceNow ATF suite), carry that into the PR as **unverified here**.

## 5. Deliver (human checkpoint)

Show: files changed, verification result and what is unverified, open risks. Ask
**once**: "Open a draft PR?" Only after a yes:

1. Branch: the session's designated branch if the environment names one, otherwise `sdlc/<short-slug>`.
2. Commit the change plus any `.sdlc/` updates; push.
3. Open a **draft** PR with the GitHub tools: summary, verification evidence, the unverified list, and the pipeline path (level, steps, revisions). Never merge.
4. `sdlc-lifecycle deliver --pr <url> --branch <branch>`. This refuses unless the verification is fresh for exactly this content.
5. Offer to watch the PR for CI and review comments.

## 6. Retro (always, brief)

```
sdlc-history summary
```

Mention any signal worth acting on in one line. If this run exposed a **durable,
general** rule (a mistake that happened, was caught, and would recur), propose at most
one lesson and add it only if the user agrees:
`sdlc-lessons add "<one rule>" --why "<evidence>"`. The change goes into the same PR,
so merging is the approval. Never record one-off facts or add lessons silently.

## Rules

- The hooks, not your judgment, decide when a step may run; do not edit state files.
- No merge, no deploy, no secrets in code, prompts or PR text.
- Do not claim something is verified unless `sdlc-verify` reported it.
