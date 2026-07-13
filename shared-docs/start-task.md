---
name: start-task
description: Use when starting work on a ticket — fetches ClickUp task + comments + attachments, builds context brief, confirms repos, creates worktrees, then picks a development approach
---

# Start Task

## Overview

Bootstraps ticket work: fetches ClickUp details + comments + attachments → synthesizes context brief → confirms repos → creates isolated worktrees with properly named branches → picks development approach.

**Announce at start:** "Using start-task skill to set up your workspace."

---

## Step 1 — Get Ticket ID

If not provided in args, ask:

```
AskUserQuestion: "What is the ClickUp ticket ID? (e.g. DROID-14915)"
```

---

## Step 2 — Fetch Ticket Details

**Use the ClickUp REST API directly via curl** — the `mcp-clickup` package is broken for custom task IDs (it omits `team_id`, causing OAUTH_027).

First, resolve credentials once and store them:

```bash
TOKEN=$(python3 -c "import json; d=json.load(open('/home/user/.claude.json')); print(d['mcpServers']['clickup']['env']['CLICKUP_API_TOKEN'])")
WORKSPACE=$(python3 -c "import json; d=json.load(open('/home/user/.claude.json')); print(d['mcpServers']['clickup']['env']['CLICKUP_WORKSPACE_ID'])")
```

Fetch the task, its comments, and check for attachments **in parallel**:

```bash
# Task details (includes attachments[] in response)
curl -s "https://api.clickup.com/api/v2/task/$TICKET_ID?custom_task_ids=true&team_id=$WORKSPACE" \
  -H "Authorization: $TOKEN" | python3 -m json.tool

# Comments
curl -s "https://api.clickup.com/api/v2/task/$TICKET_ID/comment?custom_task_ids=true&team_id=$WORKSPACE" \
  -H "Authorization: $TOKEN" | python3 -m json.tool
```

Extract from **task** response:
- **`name`** — used for branch slug
- **`description` / `text_content`** — requirements, acceptance criteria
- **`tags[].name`** — `bug` → `fix/`, others → `feature/` or `chore/`
- **`project.name`** — strong repo signal (e.g. "FE" → FE frontend)
- **`list.name`** — secondary repo signal
- **`attachments[]`** — list of files: note `title`, `url`, `mimetype` for each

Extract from **comments** response:
- **`comments[].comment_text`** — plain text content
- **`comments[].user.username`** — commenter (look for PM, QA, design roles)
- **`comments[].date`** — recency (most recent = highest signal)
- Focus on comments that add requirements, clarify behavior, or flag blockers

---

## Step 3 — Build Context Brief

Before proceeding, synthesize what was gathered and present it to the user as a structured brief:

```
## Context Brief — <TICKET-ID>

**Title:** <task name>

**Goal:** <1–2 sentence summary of what needs to be built or fixed>

**Key requirements:**
- <bullet from description or acceptance criteria>
- ...

**Constraints / edge cases noted:**
- <from description or comments>
- ...

**Notable comments:**
- <username> (<date>): <key point>
- ...

**Attachments:** <list filenames/types, or "none">

**Open questions (if any):**
- <things that are unclear that may need clarification before starting>
```

If there are open questions, ask the user now via `AskUserQuestion` — don't defer them.

---

## Step 4 — Determine Branch Name

Follow the **branching** skill exactly:

| Ticket signal | Prefix |
|---|---|
| Title starts with `BUG-` | `fix/` |
| Title starts with `RFE-` | `feature/` |
| `chore`, `refactor`, `docs`, `ci` | `chore/` |

Format: `<prefix>/<TICKET-ID>/<short-dash-slug>`

Propose to the user before creating. Wait for confirmation.

---

## Step 5 — Infer Repos & Confirm

Infer from ticket name + description + tags:

| Signal words | Likely repo |
|---|---|
| UI, frontend, React, page, component, dashboard, modal, form | **FE** |
| API, endpoint, backend, database, migration, service, model, query | **BE** |
| bastion, proxy, auth-proxy, SSH, tunnel | **auth-proxy-backend** |

Default assumption if unclear: **FE**.

Present assumption via `AskUserQuestion` with **multiSelect: true** — let user pick one or more:
- FE (frontend)
- BE (backend)
- auth-backend-service (another backend)
- payments-service (another backend)


State your inferred assumption clearly so the user can confirm or override.

---

## Step 6 — Discover Repo Paths

```bash
# Find sibling directories to the current repo
ls "$(dirname "$(git rev-parse --show-toplevel)")"
```

Map repo names to full paths:
- **FE** → `<parent>/FE`
- **BE** → `<parent>/BE`
- **auth-proxy-backend** → `<parent>/auth-proxy-backend`

---

## Step 7 — Create Worktree + Branch Per Repo

### Create with `git worktree add`

Pick a short slug (ticket ID + short description, no slashes — used as directory name):

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
SLUG="DROID-XXXXX-short-description"   # e.g. DROID-15021-extend-error-messages
WORKTREE_PATH="$REPO_ROOT/.claude/worktrees/$SLUG"

git worktree add "$WORKTREE_PATH" -b "<branch-name>"
```

Then copy `.env`:
```bash
cp "$REPO_ROOT/.env" "$WORKTREE_PATH/.env" 2>/dev/null && echo "copied .env" || echo "no .env found"
```

Do **NOT** run `npm install` — node_modules are shared via the main checkout.

For **multiple repos**: repeat per repo.

### Bind this session to the ticket (status bar)

After the worktree(s) exist, bind **this** session to the ticket so the status
bar surfaces the ticket's FE/BE dev-server ports **from any cwd** — even when
the only worktree created is in the **opposite** repo (a BE session
cannot switch into a FE worktree, and vice-versa), or when you stay in the base
checkout. Without the binding the bar goes blind outside the worktree.

```bash
bash ~/.claude/scripts/dev-registry.sh bind "$CLAUDE_CODE_SESSION_ID" "<TICKET-ID>"
```

- `<TICKET-ID>` = the bare ticket token (e.g. `DROID-15021`). A full slug is
  fine too — it's normalized to the token. This is what pairs the FE and BE
  servers, so the bar shows **both** ports regardless of which side you're on.
- Read the session id from the `CLAUDE_CODE_SESSION_ID` env var — never hardcode.
- The `run-dev` skill binds the same way when it launches a server; SessionEnd
  unbinds automatically. Re-running `start-task` / `run-dev` re-points it.

### Switch this session into its own repo's worktree (optional, preferred)

`EnterWorktree` is **repo-scoped** — it can only switch into a worktree of the
repo **this session is anchored to**. A FE worktree is rejected from a
BE session (and vice-versa); there is no cross-repo switch and no
common parent repo to anchor at. So:

- If a worktree was created in **this session's own repo**, switch into it —
  you get the correct git context + file paths, and the bar also resolves via
  cwd:
  ```
  EnterWorktree({ path: "<that repo's WORKTREE_PATH>" })
  ```
  Use the `path` variant on the just-created worktree. The switch **persists
  across turns** (verified), and `ExitWorktree` never auto-removes a
  path-entered worktree, so the work is safe. Never `git branch -m` inside it
  (breaks tracking). Which repo is "this session's" = `dirname "$(git rev-parse
  --git-common-dir)"`; a created worktree is switchable iff it appears in `git
  worktree list`.
- For **every other repo's** worktree (different repo → not switchable), print
  the new-session block in Step 9 (`cd <path> && claude`). The binding above
  already makes the bar correct there; that new session re-binds itself.
- If **no** worktree was created in this session's own repo (e.g. an FE-only
  ticket run from a BE session), don't switch — the binding carries the
  bar; just print the new-session block.

### Cross-repo API contract (BE + FE)

If the selected repos include **both `BE` and `FE`**, flag the contract rule now so it isn't forgotten at the end. There are two mechanisms — pick per endpoint:

> **New or migrated endpoint → `@devicetotal/contract` package (ts-rest + Zod).** Define the endpoint's request/response Zod schema + route **once** in the shared package (repo `arcus-team/web-contract`); both repos install it from git and import it. The FE consumes via `@ts-rest/core`, the BE implements via `@ts-rest/express` — one schema, typed both ends, validated at runtime. Any brand-new endpoint is contract-first. While the contract change is unreleased, link it into both worktrees with `yalc` (never `npm link` / `file:`); once released, both consumers pin a git tag.
>
> **Un-migrated (legacy) endpoint → `shared/types.d.ts`.** Still generated by the backend and consumed by the frontend via `@shared/*`. After any BE change that touches an **exported** type, regenerate + sync before FE relies on it:
> ```bash
> # in the BE worktree
> npm run export:types
> # sync to the FE worktree
> cp shared/types.d.ts <FE-worktree>/shared/types.d.ts   # then `diff -q` to confirm identical
> ```
> BE must be tsc-clean project-wide (full declaration emit) or it fails. See `BE/CLAUDE.md` → "FE↔BE API Contract".
>
> The `cross-repo-coordinator` agent, if dispatched in Step 10, picks the mechanism, then stages, gates, and verifies whichever applies — see Step 10.

---

## Step 8 — Pick Development Approach

Present the context brief summary alongside an approach menu. Use `AskUserQuestion` with `singleSelect: true`:

```
Based on the ticket context, which development approach do you want to use?
```

| Option | Skill to invoke | When it fits |
|---|---|---|
| **rpi** — Research → Plan → Implement | `rpi:research` | Scope is unclear, API contract doesn't exist yet, needs discovery before coding |
| **gsd** — Phased delivery | `gsd:plan-phase` | Complex multi-phase feature with clear milestones and phases |
| **superpowers: write plan first** | `superpowers:writing-plans` | Scope is known, but changes are non-trivial and benefit from a written plan before execution |
| **superpowers: TDD** | `superpowers:test-driven-development` | Bug fix or feature with clear acceptance criteria — tests first |
| **Direct implementation** | *(no skill — just start)* | Small, well-scoped change; requirements fully clear from ticket |

**Recommendation heuristics** (state your recommendation and why, then let the user confirm):
- Bug with reproduction steps → TDD
- New feature with unknown backend API → rpi
- New feature with defined API + multiple moving parts → gsd or write-plan-first
- Small UI tweak / config change → direct implementation

**If `BE` is among the selected repos:** recommend delegating the implementation to the `backend-developer` agent (via the Agent tool, `subagent_type: backend-developer`) regardless of approach. It enforces the project constitution and the 3-database / repository-pattern / unit-fetch / scoring gotchas automatically. State this in your recommendation so the user can opt out.

After the user selects, invoke the chosen skill immediately (or announce "proceeding directly" if they chose direct implementation).

---

## Step 9 — Report Summary

List all created worktrees, mark which one this session switched into, and give
the open block for the rest. State that the session is bound to the ticket so
the status bar tracks its dev-server ports from anywhere.

```
✓ BE → /home/.../projects/BE/.claude/worktrees/<slug>   ← switched this session in
✓ FE         → /home/.../projects/FE/.claude/worktrees/<slug>           (different repo — open a new session)

Branch: feature/DROID-14915/RFE-short-description
Approach: rpi (research first)
Status bar: bound to DROID-14915 (ports tracked from any cwd)

Open the other repo(s) in a new Claude Code session:
  cd /home/.../projects/FE/.claude/worktrees/<slug>
  claude
```

- If a worktree was created in this session's own repo, note it as **switched
  in** (you're already there — no `cd … && claude` needed).
- If this session's repo got no worktree (opposite-repo-only ticket), say so and
  give only the new-session block — the binding keeps the bar correct here.

---

## Step 10 — Offer Cross-Repo Coordination (FE + BE only)

**Trigger:** both **FE** and **BE** were selected in Step 5 and their worktrees were created.

This is **orthogonal to Step 8**: Step 8 delegates BE *coding* to `backend-developer`; Step 10's `cross-repo-coordinator` orchestrates the *coupling* between the two repos (sequencing, the `shared/types.d.ts` contract, integration). They are not alternatives — both can run.

Offer to dispatch the coordinator in `kickoff`:

```
Agent(
  subagent_type: "cross-repo-coordinator",
  prompt: "phase=kickoff. Ticket <TICKET-ID>. FE worktree=<FE worktree path>. BE worktree=<BE worktree path>. <context brief from Step 3>."
)
```

- Pass the **bare ticket ID** (regex `DROID-\d+`), not the slug.
- **Worktree discovery** keys on the ticket-ID prefix: `<repo>/.claude/worktrees/<TICKET-ID>*` (same convention as the `run-dev` skill). Do not assume an exact shared slug.
- The coordinator returns a proposed contract + sequencing for **you** to present to the user (`AskUserQuestion`); on approval, dispatch it again with `phase=write-briefs` and an approval marker.
- **Standalone use:** if the worktrees already exist from a prior session, the user can dispatch `cross-repo-coordinator` directly without re-running start-task.
- **First-run permissions:** if a restrictive `settings.json` blocks the coordinator's writes, allow `Write(~/.claude/coordination/*.md)` and `Write(**/.claude/worktrees/**/COORDINATION.md)`.

---

## Quick Reference

| Step | Action |
|---|---|
| No ticket ID | AskUserQuestion |
| Task lookup | curl ClickUp REST API (custom_task_ids + team_id) |
| Comments lookup | curl `/task/{id}/comment` |
| Attachments | Parsed from task response `attachments[]` |
| Context brief | Synthesize before any decisions |
| Branch name | Use branching skill |
| Repo choice | AskUserQuestion, multiSelect, state assumption first |
| Worktree | `git worktree add` → copy `.env` → `dev-registry.sh bind $CLAUDE_CODE_SESSION_ID <TICKET>` → `EnterWorktree({path})` into this repo's WT (other repos: `cd <path> && claude`) |
| Approach | AskUserQuestion, singleSelect, recommend with rationale |

## Common Mistakes

- **Don't create worktrees before confirming branch name** — user may want a different slug
- **Don't assume single repo** — many tickets touch both frontend and backend
- **Always state your repo assumption** before presenting the confirm dialog — makes it easy to override
- **Don't skip `.gitignore` check** — worktree dirs must be ignored
- **Don't skip the context brief** — it surfaces open questions before work begins
- **Don't skip approach selection** — picking the wrong workflow costs more than the 30 seconds to ask
- **Don't forget the cross-repo contract** — when a task spans `BE` + `FE`: a new/migrated endpoint goes through the `@devicetotal/contract` package (define the Zod schema once, `yalc`-link both worktrees while unreleased); a legacy endpoint still needs the `npm run export:types` → `cp shared/types.d.ts` sync, or the FE builds against stale types
