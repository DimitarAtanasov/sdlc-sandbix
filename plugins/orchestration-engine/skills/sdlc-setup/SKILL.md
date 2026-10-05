---
name: sdlc-setup
description: One-time setup of a repo for the AI SDLC framework - registers the marketplace and plugins in .claude/settings.json, creates .sdlc/verify.json (autodetected checks) and .sdlc/lessons.md. Use when the user wants a repo to work with /sdlc from a fresh session, including phone sessions.
---

# SDLC setup

1. Show what would change (writes nothing):
   ```
   sdlc-setup --print
   ```
2. Explain it in two lines and ask the user to approve. It is non-destructive: existing settings keys are kept.
3. Apply:
   ```
   sdlc-setup
   ```
4. Tell the user to **commit** `.claude/settings.json` and `.sdlc/` so every future session picks them up.
5. If `.sdlc/verify.json` still contains `REPLACE-WITH-YOUR-TEST-COMMAND`, ask what command runs the
   project's tests (and which checks cannot run in a container, for example a ServiceNow ATF suite,
   which belong as `"manual": true` entries) and fill it in.

Caveat to state plainly: the `.claude/settings.json` marketplace entry follows the documented shape but
was not verified in a trust-gated session. If the plugins do not appear in a fresh session, add them by
hand once: `/plugin marketplace add dimitaratanasov/sdlc-sandbix`, then
`/plugin install orchestration-engine@sdlc-sandbix` and `/plugin install sdlc-agents@sdlc-sandbix`.
