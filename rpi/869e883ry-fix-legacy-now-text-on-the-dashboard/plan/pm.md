# pm.md — legacy Now text on the dashboard

**Ticket**: `869e883ry` · Type: UI consistency fix (no new product surface)

## Problem

The dashboard's "Inside" block is the one place a user can answer "what is this stage actually doing/did?" — evidence-backed, persistent, click-to-revisit. Ship doesn't use it consistently:

- Before ship runs: static placeholder prose instead of the stage's actual predefined steps.
- While ship runs: a transient one-line spinner hijacking the unrelated "Now" call-to-action line ("Writing PR description…"), unreadable once it changes, never revisitable.
- After ship runs: correctly structured (PR + merge rows) — this part already works.

Review and UAT have the same "before it runs" gap (blurb prose instead of their known gate list), just less visible since gates are fast.

## User value

A user watching a ticket ship (often the slowest, most externally-visible stage — network calls, gh CLI, LLM description) currently has no durable read on what's happening per repo. They see a spinner label that disappears. If a repo hangs mid-push, there's no way to tell which repo or which step without the output channel. Bringing ship (and the pending-state gap on review/uat) into the existing Inside pattern gives the same "click back to any stage, see what happened" guarantee ship already gets for its finished state.

## Scope

**In**: Ship's live per-repo/per-step progress moves into the Inside block; ship's pre-run state shows its predefined steps as pending; review/uat's pre-run state shows their gate list as pending (they already show it correctly once running).

**Out**: `impl`/`fix` stay on blurb text before running — their steps are agent-declared per approach, not karst-predefined, so there is nothing to enumerate in advance (confirmed as an intentional distinction elsewhere in the codebase, not a gap). No changes to the Now line's wording for any stage except ship's in-flight sentence (which currently gets fully overwritten by the hijack and needs real copy once it isn't).

## Acceptance criteria

1. Ship, not yet started: Inside block shows one predictable row per hot repo group (pr + merge), status `pending` — not the static blurb sentence.
2. Ship, running: Inside block shows live per-repo, per-step rows (commit → push → describe → pr → merge) transitioning pending → running → pass/fail as they happen; the Now line shows a plain "shipping in progress" sentence, no button, no step narration.
3. Ship, finished: unchanged from today — PR + merge rows per repo (this already works and must not regress).
4. Review/UAT, not yet started: Inside block shows the gate list (lint/typecheck/test) as `pending` rows, not blurb prose. Once running, unchanged from today (already correct).
5. No stage anywhere falls back to free-form text when it has a known, enumerable process list. `impl`/`fix` still show blurb before running — this is intentional, not a leftover bug.
6. No regression to any currently-passing dashboard test.

## Out of scope / explicitly deferred

- Extending predefined-process display to `impl`/`fix` (agent-declared steps).
- Persisting ship's per-step progress server-side (it stays a transient, in-memory-only live view, same durability class as today's `ship-progress` message — only its destination and shape change).
