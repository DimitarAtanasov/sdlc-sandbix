# Lessons seed (PROPOSALS, not approved lessons)

General lessons from an earlier multi-agent project (a clean-room simulation port worked by a lead
session plus parallel agents). They are **proposals for human approval**. Nothing here is added to any
`.sdlc/lessons.md` automatically.

How to adopt one: in `/retro`, propose it to the user with its evidence; only if they approve, run the
command below in the target repo so the change travels in a PR (merging is the approval). The engine
caps lessons at 20 lines / 2000 bytes, so adopt only the ones that match failures this project has
actually had, and prune first if the file is full. The evidence is from the source project; replace it
with your own when you have it.

1. Clean-copy verification
   ```
   sdlc-lessons add "Verify an agent's work in a clean checkout of HEAD plus only that agent's files, never a copy of the working tree" --why "working-tree copy carried other agents' unfinished files: false failures"
   ```
2. Reports are claims
   ```
   sdlc-lessons add "An agent's report is a claim: accept only results you reproduced, and mutation-check every new test" --why "green reports hid gaps that a later audit found"
   ```
3. File ownership in parallel work
   ```
   sdlc-lessons add "Parallel agents own disjoint files; the lead is the only writer of shared files (indexes, wiring, handoff)" --why "agents appending to one shared file collided"
   ```
4. The evaluator is the judge
   ```
   sdlc-lessons add "A deterministic evaluator judges loops and runs; when it fails, fix the loop or the run, never the evaluator" --why "its first run caught an unlabelled branch that review missed"
   ```
5. Budgets are counters
   ```
   sdlc-lessons add "Declare retry and usage limits as budget counters the controller enforces, not as requests to agents" --why "requested limits were not counted; enforced ones stopped retries"
   ```
6. Green tests have edges
   ```
   sdlc-lessons add "A green test proves only the inputs it reaches; audit the edges (limits, overflow, strict parsing) too" --why "matching test vectors missed overflow and parser gaps"
   ```
7. Uncertain rules are policies
   ```
   sdlc-lessons add "Record a rule whose correct behaviour is uncertain as a switchable policy with a default, not hard-coded" --why "ambiguous reference behaviour: experiments then change data, not code"
   ```
8. Hooks do not justify commits
   ```
   sdlc-lessons add "Never commit unverified work to quiet an uncommitted-changes hook; wait for verification" --why "the hook fires while agents are mid-work, by design"
   ```

Left out on purpose: anything tied to that project's build tool, reference sources, data formats or
golden hashes.
