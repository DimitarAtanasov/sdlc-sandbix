---
name: retro
description: Review how the AI SDLC pipeline has been performing and propose improvements - lessons to add or prune and agent-team changes - from recorded run history and, optionally, PR review comments. Use after a batch of runs, or when the user asks what the pipeline keeps getting wrong.
---

# Retro

Evidence first, proposals second, changes only with approval.

1. Read the evidence:
   ```
   sdlc-history summary
   sdlc-history list --limit 15
   sdlc-lessons list
   ```
   If the user gives a PR number, also read its review comments with the GitHub tools; reviewer
   corrections are the strongest source of lessons.
2. Find patterns that **recurred**: a step that keeps asking, being revised or declining; a review
   step that never finds anything; the same reviewer correction on several PRs. A single
   occurrence is an anecdote, not a lesson. With fewer than 5 runs, say there is not enough data.
3. Propose, in a short list:
   - **Lessons to add** (one rule each, under 200 chars, with the evidence). The list is capped at
     20; if it is full, propose which one to remove or merge first.
   - **Lessons to remove** (obsolete, duplicated, or never relevant).
   - **Agent changes** (keep / make conditional / merge / remove), citing the numbers. For a deeper
     audit use `/agent-architect`.
4. Apply only what the user approves: `sdlc-lessons add|remove ...` edits `.sdlc/lessons.md`,
   which should go into a PR so merging is the human approval. Never edit agents or lessons silently.
