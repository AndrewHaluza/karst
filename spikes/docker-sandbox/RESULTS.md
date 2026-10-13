# Docker Sandbox feasibility spike — results (ST2, Increment 0)

Ticket: SANDBOXED-AUTONOMOUS-AGENT-s2 (T669). Plan: `docs/superpowers/plans/2026-07-28-docker-sandbox-agent-sessions.md` §Increment 0. Spec: `docs/superpowers/specs/2026-07-28-docker-sandbox-agent-sessions-design.md`. Date: 2026-10-13. Scripts and raw logs: `spikes/docker-sandbox/`, `logs/`.

## Verdict: CONDITIONAL GO

Terminal, subscription auth and isolation pass for Claude and Codex. One bridge candidate (host polling of an append-only event file) works with measured low latency. Conditions before ST3 proceeds to the Docker runner (ST3 itself, the zero-behaviour-change `SessionRunner` seam, can start):

1. **Git inside a linked worktree is broken in direct mount mode.** The worktree `.git` file points at `repo/.git/worktrees/<wt>`, which is not mounted, so `git` fails with `fatal: not a git repository`. Candidate fixes: `sbx create --clone` (tested, works, see exp 10; commits arrive as a host remote branch, not live in the worktree) or mounting the shared `.git` (not tested; widens exposure and exposes hooks). Karst must pick one and test it with its real worktree layout.
2. **Evidence authenticity.** The event file is agent-writable. The host must bind events to a ticket by file path (one file per ticket worktree) and verify stage on the host; line content cannot be trusted.
3. **Codex raw-credential isolation was not fully checked** (see exp 5).

## Environment

macOS 26.6.2, arm64 (Darwin 25.6.0); Docker Desktop 29.1.3; `sbx` v0.48.0 (installed via `brew install docker/tap/sbx`, user-run). The pre-installed `docker sandbox` plugin v0.6.0 was NOT usable: it supports only `claude` and `gemini`, with no `create`, `exec`, `ports` or `stop`. Host changes made for the spike (user-run or user-approved): `sbx` install, `sbx login`, `sbx policy init balanced`, `sbx secret set openai --oauth` (global).

## Experiments

| # | Experiment | Result |
|---|---|---|
| 1 | Capability discovery | PASS |
| 2 | Interactive Claude | PASS (MANUAL) |
| 3 | Interactive Codex | PASS (MANUAL, per-item detail not reported) |
| 4 | Filesystem boundary | PASS, with git finding |
| 5 | Credential and Docker boundary | PASS for Claude, PARTIAL for Codex |
| 6 | Lifecycle bridge candidates | One viable (C) |
| 7 | Evidence | PASS with condition 2 |
| 8 | Ports | PASS |
| 9 | Cleanup | PASS |
| 10 | Extra: git in clone mode | PASS |

### 1 Capability discovery (`logs/01-discovery.log`)
`sbx` found at `/opt/homebrew/bin/sbx`. Agents available: claude, codex, copilot, cursor, devin, docker-agent, droid, gemini, kiro, opencode, shell. Every daemon command fails with `error: not signed in to Docker` until `sbx login` (device flow, user completed). `sbx create` also requires a global network policy (`sbx policy init`), written once; we chose `balanced`. Local sandboxes run on macOS arm64; Linux and Windows prerequisites not tested here.

### 2 Interactive Claude (`logs/02-claude.notes.md`)
a-f all PASS, run by the user in a real TTY: subscription OAuth (no API key), streaming, resize, Ctrl-C interrupt, reattach, kill plus `-- --continue` resume. Final argv inside the sandbox: `claude --dangerously-skip-permissions --continue`. The sandbox supplies the bypass flag, and agent args after `--` are appended and accepted (open question 4: yes for `--continue`; other flags untested).

### 3 Interactive Codex
User reported PASS for the checklist (no per-item detail). The process list showed `codex resume --last`, so resume args pass through; no bypass flag was visible in that argv. Codex needed `sbx secret set openai --oauth` on the host BEFORE sandbox creation; a login inside the sandbox is not saved and every new codex sandbox starts logged-out.

### 4 Filesystem boundary (`logs/04-fs-boundary.log`)
- Worktree write visible on host: PASS.
- Sibling worktree read and write: PASS (blocked; the path does not exist in the sandbox).
- Symlink escape to `/`: PASS (the target resolves inside the sandbox, no host data).
- Host home, `/Users` and Karst global storage unavailable: PASS.
- **Finding:** `git` in the mounted linked worktree fails (see condition 1). Tested on the Claude sandbox only.

### 5 Credential and Docker boundary (`logs/05-cred-docker.log`)
Claude: no raw credential files found; `GH_TOKEN=gho_sbxproxymanaged...` and `SBX_CRED_ANTHROPIC_MODE=none` are proxy placeholders; the sandbox has its own Docker daemon (ID `38f2660e...` vs host `71902dfa...`); `/var/run/docker.sock` is the sandbox's own; requests to a private IP and `host.docker.internal` return proxy 403. Codex: `~/.codex/auth.json` exists inside the sandbox. Its contents were NOT inspected (the credential read was blocked by the session's safety classifier and not worked around), so whether it is a placeholder or a real token is **unverified**. `sbx create --mount-docker-socket`-style options exist; Karst must never pass them.

### 6 Lifecycle bridge (`logs/06-bridge.log`)
- Candidate C, host polls an append-only NDJSON in the mounted worktree: 20 of 20 events, p50 28 ms, p95 51 ms (dominated by a 50 ms poll). If the host receiver is down, events persist in the file. Selected.
- Candidate B, sandbox-to-host relay on host loopback: blocked by default (proxy 403). Would need an explicit policy allow rule; not pursued.
- Candidate A, supported local-service routing: no dedicated mechanism found in `sbx` help beyond `ports` (host-to-sandbox only). Not prototyped.

### 7 Evidence (`logs/07-evidence.log`)
The sandbox can append arbitrary lines, including a forged other-ticket `impl-complete`; the host sees both. Mitigation is path binding (other tickets' worktrees are not mounted, exp 4) plus host-side stage verification. No Karst DB, `KARST_*` env or SQLite file is visible in the sandbox (only man-page `index.db`).

### 8 Ports (`logs/08-ports.log`)
Dev server in the sandbox, `sbx ports --publish 18123:8123`, host health check returned 200. Stop takes 1 s. The mapping is hidden from `sbx ports` while the sandbox is stopped and reappears with the sandbox on restart (curl 200 again). Karst must treat the listing as valid only while the sandbox runs.

### 9 Cleanup (`logs/09-cleanup.log`)
Stop 0.4 s; restart via exec 1.6 s; `sbx rm --force` (non-TTY requires `--force`) removed only the named sandbox; worktree files remained; host canary file untouched. Sandbox data dir 5.7 G to 5.3 G after removing one sandbox (mostly shared images).

### 10 Extra: clone mode (`logs/10-git-clone.log`)
`sbx create --clone claude <repo>`: source mounted read-only, git works inside, a commit made in the sandbox appears on the host as remote `sandbox-<name>/main` via a loopback git daemon. Edits are not live in the worktree; Karst would fetch and merge. Leaves a remote on the host repo that must be cleaned on remove.

## Latency and footprint

| Measure | Value |
|---|---|
| Create, first (image pull) | 103 s Claude, 61 s Codex |
| Stop | 0.4-1 s |
| Restart (exec on stopped) | 1.6 s |
| Bridge C event latency | p50 28 ms, p95 51 ms |
| Reattach / OAuth login | not timed |
| Disk | about 5.3-5.7 G shared data dir |
| Memory | default 8 GiB limit, 10 CPUs (auto); actual RSS not measured |

## Open questions from the plan

1. Transport: file polling (C) works; relay needs a policy rule.
2. Shared git metadata: NOT exposed in direct mode; see condition 1.
3. OAuth persistence: Claude via the sandbox login, Codex via host `sbx secret set openai --oauth` (global).
4. Provider args: `--continue` and `resume --last` accepted; full arg set untested.
5-8. Not answered (stop-on-close policy, orphan accounting, supported OS matrix, headless sandbox sharing).

## Not run or partial

Codex versions of exp 4 and 5; Codex argv line (partial); per-item Codex timings; Linux and Windows; Karst real hook payloads; bridge hardening; mounting the shared `.git`.

## Design §15 approval criteria

| Criterion | Status |
|---|---|
| Interactive I/O in terminal | PASS (system terminal; the VS Code terminal itself untested) |
| Subscription OAuth, Claude and Codex | PASS |
| Close/reconnect and provider resume | PASS |
| Acceptable-latency lifecycle events | PASS (C) |
| Authenticated stage marker without DB access | PARTIAL (path binding; needs host verification) |
| Direct-mode edits visible on host | PASS (files), FAIL (git) |
| One published dev-server port | PASS |
| Host fs, host Docker, private IP, credential isolation | PASS (Claude), PARTIAL (Codex credentials) |
| Deterministic stop/remove/reconcile | PASS |

## Residual risk

Inside the sandbox the agent can still damage its own worktree and branch, send code out over allowed network hosts, and follow prompt injection from repo content. Autonomy trades per-command approval for diff review.

## Handoff

CONDITIONAL GO: the umbrella (T667) may spawn ST3, plan Increment 1 (`SessionRunner` seam, zero behaviour change). The Docker runner increments (2+) stay gated on conditions 1-3 above.
