---
name: second-brain
description: Keep a durable, version-controlled project memory in docs/memory - typed notes (lesson, fact, preference, pointer) with evidence and a date, recalled before work, captured after a surprise, pruned before a handoff - plus an optional Graphify code map built by brain-index. Use at session start, after a mistake or correction, and before a handoff.
---

# Second brain (project memory)

Memory lives in git as plain markdown, so it survives sessions, can be reviewed and reverted, and every
agent can read it. Entry point: `docs/memory/MEMORY.md`, an index with one line per note.

## Principles
- **Store only what code and git history cannot tell you**: why something was decided or went wrong,
  environment facts, owner preferences, pointers. Never copy code, design docs or the commit log.
- **Simplicity first.** One idea per note. The index stays at or under 150 lines; when it grows, merge
  or delete notes.
- **Goal-driven.** A note exists to change a future action. If you cannot say which, do not write it.
- **Surgical.** Update the existing note instead of adding a near-duplicate.
- **Memory is a hint, not truth.** A note may be stale. Before acting on one that names a file,
  command, flag or number, check it against the repo or by running it, and fix the note if it is wrong.

## Note format
`docs/memory/<topic>.md`, kebab-case, `name` equal to the file name (template: the plugin's
`templates/memory-note.md`):
```
---
name: <topic>
type: lesson | fact | preference | pointer
updated: YYYY-MM-DD
evidence: <commit, PR, ADR, command or file that supports it>
---
<the rule or fact in one or two sentences>
Why: <the incident or reason>
How to apply: <when it matters and what to do>
```
Index line in `MEMORY.md`: `- [topic](topic.md) - one-line hook`. Every note is listed; every link resolves.
A note without evidence or a date is not kept.

## Operations
1. **Recall** (session start, and before a risky step): read `MEMORY.md`, open the notes whose hook
   matches the task, then the current handoff if there is one. Say in one line which notes you apply.
2. **Capture** (after a surprise, an owner correction, or a failure): write or update the note in the
   same change that fixes the problem, with its evidence. Record an owner decision as a pointer to
   where it is decided (ADR, issue), not a copy.
3. **Consolidate** (before a handoff, or every few rounds): merge duplicates, delete what the code now
   makes obsolete, re-check dated facts, keep the index current. Say what you removed in the PR.
4. **Check**: `MEMORY.md` at most 150 lines; every `docs/memory/*.md` listed; frontmatter has `name`,
   a `type` from the four, `updated` as `YYYY-MM-DD`, non-empty `evidence`. (No linter ships for this
   yet; check by reading.)

## Notes and the engine's lessons (`.sdlc/lessons.md`)
If the orchestration-engine plugin is installed, it injects `.sdlc/lessons.md` into every pipeline
agent. That file is short (20 rules / 2000 bytes), human-approved, and costs context on every run.
Memory notes are the long form: the incident, the evidence, how to apply.
- A note becomes a lesson only by promotion: propose the one-line rule in `/retro`, and if the user
  approves, run `sdlc-lessons add "<rule>" --why "<evidence>"` so it lands in the PR. Merging the PR is
  the approval. Never add a lesson automatically, and never edit `.sdlc/lessons.md` by hand.
- Promote only what recurred or would have prevented a real failure; keep the note as the source.
- When a lesson is pruned, keep or delete the note on its own merits.
The plugin's `docs/lessons-seed.md` lists general proposals in that format.

## Code map (optional): `brain-index`
`brain-index` rebuilds a Graphify knowledge graph of the committed code (`graphifyy` 0.9.100, pinned,
Apache-2.0) into `docs/codebase-index/`: `GRAPH_REPORT.md` (start here), `graph.html`, `graph.json`,
and a generated `README.md` naming the indexed commit. Tree-sitter parses the code locally with no
model call. The tool installs into a throw-away venv and reads `git archive HEAD` only, so uncommitted
work is never indexed. It needs Python 3 and access to PyPI.
- `BRAIN_INDEX_OUT` (default `docs/codebase-index`), `BRAIN_INDEX_EXCLUDE` (space-separated paths to
  leave out, such as generated data), `BRAIN_INDEX_PYTHON` (default `python3`).
- Use it for navigation ("what calls what"), never as evidence: it is a snapshot of one commit. Check
  the commit in its README and rebuild when HEAD has moved. Commit the output only if the team wants
  it in the repo; add a `pointer` note to it when you do.

## What never goes in
Secrets or tokens, personal data beyond what the owner put in the repo, third-party proprietary files
or excerpts, large logs, anything already in the code or a decision record.

## Relationship to other records
- Decision records hold decisions; memory holds the lessons and facts behind them.
- A handoff file is the resume point of the current work; memory persists across all work.
- Loop contracts in `docs/loops/` say how work proceeds; memory says what was learned doing it.
