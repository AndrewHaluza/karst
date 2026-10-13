# Docker Sandbox feasibility spike — results (ST2, Increment 0)

Ticket: SANDBOXED-AUTONOMOUS-AGENT-s2 (T669). Plan: `docs/superpowers/plans/2026-07-28-docker-sandbox-agent-sessions.md` §Increment 0. Spec: `docs/superpowers/specs/2026-07-28-docker-sandbox-agent-sessions-design.md`. Date: 2026-10-13. Scripts: `spikes/docker-sandbox/*.sh`; raw evidence: `spikes/docker-sandbox/logs/` (committed on purpose; reviewed, only proxy placeholders, no secrets).

## Verdict: CONDITIONAL GO

### How the plan's rule applies

| Rule text | Finding |
|---|---|
| NO-GO if subscription login cannot be supported | Not triggered. Claude and Codex subscription OAuth both work (exp 2, 3). |
| NO-GO if interactive terminal cannot be supported | Not triggered. Exp 2/3 pass in a real terminal. The VS Code terminal itself was NOT tested. |
| NO-GO if safe evidence cannot be supported | Not triggered. Path-bound file bridge plus host verifier rejects other-ticket/other-stage markers (exp 7). |
| NO-GO if direct worktree behavior cannot be supported | **Borderline.** File-level direct behavior works (host sees edits, siblings/home invisible). **Git inside a direct-mounted linked worktree does not**, and the only direct-mode fix tested (mount the shared `.git`) is unsafe (exp 12). The safe path is clone mode (exp 10), which is a different workspace model. |
| GO if all §15 criteria pass or have a bounded, tested fix | Not met: git in direct mode has a tested safe alternative (clone mode) but not a drop-in fix. |
| CONDITIONAL GO if terminal/auth/isolation pass and the bridge has one viable prototype with documented hardening | **Met** for Claude and Codex: terminal and auth pass, isolation passes (exp 4, 5, 11), bridge candidate C works (exp 6) with hardening listed below. |

Judgment call, flagged for the umbrella: if direct-mode git is a hard product requirement, read the borderline row as NO-GO for the *direct-mount design* (clone mode would still be viable as a redesign). Otherwise proceed as CONDITIONAL GO.

### Conditions before the Docker runner (Increment 2+)

1. **Git model.** Do not mount the shared `.git` (a sandbox can write executable hooks there and move other branches, exp 12). Choose clone mode (exp 10: source read-only, commits arrive as a host remote, edits are not live) or a host-side git proxy, and prove it with Karst's real worktree layout.
2. **Evidence hardening.** One event file per ticket worktree; the host binds identity by path and verifies ticket and stage itself; line content is untrusted (exp 7).
3. **Codex credentials.** `auth.json` is 40 bytes inside the sandbox; contents were not read, so "placeholder" is inferred, not proven (exp 11).
4. **Terminal host.** Re-run exp 2/3 inside the VS Code terminal.

ST3 (Increment 1, `SessionRunner` seam, zero behavior change) is independent of these and may start.

## Environment

macOS 26.6.2, arm64 (Darwin 25.6.0); Docker Desktop 29.1.3; `sbx` v0.48.0 (`brew install docker/tap/sbx`, user-run). The preinstalled `docker sandbox` plugin v0.6.0 was unusable (only `claude`/`gemini`; no `create`, `exec`, `ports`, `stop`). Host changes made for the spike, user-run or user-approved: `sbx` install, `sbx login`, `sbx policy init balanced`, global `sbx secret set openai --oauth`. All `karst-spike-*` sandboxes were removed at the end (exp 9).

## Experiments

| # | Experiment | Result |
|---|---|---|
| 1 | Capability discovery | PASS |
| 2 | Interactive Claude | PASS (MANUAL, all items) |
| 3 | Interactive Codex | PASS (MANUAL, overall only; see `logs/03-codex.notes.md`) |
| 4 | Filesystem boundary (Claude) | PASS; git finding |
| 5 | Credential and Docker boundary | PASS (Claude); PASS-with-inference (Codex) |
| 6 | Lifecycle bridge | One viable candidate (C) |
| 7 | Evidence | PASS |
| 8 | Ports | PASS |
| 9 | Cleanup | PASS |
| 10 | Extra: git in clone mode | PASS |
| 11 | Extra: Codex boundary | PASS |
| 12 | Extra: shared `.git` mount | FAIL (unsafe) |

### 1 Capability discovery (`logs/01-discovery.log`)
`sbx` at `/opt/homebrew/bin/sbx`. Agents: claude, codex, copilot, cursor, devin, docker-agent, droid, gemini, kiro, opencode, shell. Every daemon command fails with `error: not signed in to Docker` until `sbx login` (device flow, user completed). `sbx create` also needs a global network policy (`sbx policy init`; we chose `balanced`). Local sandboxes verified on macOS arm64 only; Linux and Windows prerequisites not tested.

### 2 Interactive Claude (`logs/02-claude.notes.md`)
a-f PASS, run by the user in a real terminal: subscription OAuth (no API key), streaming, resize, Ctrl-C, reattach, kill plus `-- --continue` resume. Final argv: `claude --dangerously-skip-permissions --continue`. The sandbox supplies the bypass flag; agent args after `--` are appended and accepted (open question 4: yes for `--continue`).

### 3 Interactive Codex (`logs/03-codex.notes.md`)
User reported one overall PASS; no per-item detail or timings, recorded as such. Needed `sbx secret set openai --oauth` on the host before `sbx create`; a login inside the sandbox is not saved. Agent saw `codex resume --last` in the process list; no bypass flag visible.

### 4 Filesystem boundary (`logs/04-fs-boundary.log`, Claude sandbox)
Worktree write visible on host: PASS. Sibling worktree read/write: blocked (path does not exist). Symlink to `/`: resolves inside the sandbox, no host data. Host home, `/Users`, Karst storage: absent. `git` in the mounted linked worktree fails: `fatal: not a git repository` (the `.git` file points at the unmounted `repo/.git/worktrees/wt-a`).

### 5 Credential and Docker boundary (`logs/05-cred-docker.log`)
No raw credential files found (`find` for `.credentials.json`/`auth.json` empty on Claude). `GH_TOKEN=gho_sbxproxymanaged...` and `SBX_CRED_ANTHROPIC_MODE=none` are proxy placeholders. Private daemon: sandbox ID `38f2660e...` vs host `71902dfa...`. Private IP and `host.docker.internal` return proxy 403. `sbx run` has `--mount-docker-socket`; Karst must never pass it.

### 6 Lifecycle bridge (`logs/06-bridge.log`)
- **C, append-only file polled by the host (selected).** Single-clock round trip (host monotonic clock only; the earlier two-clock method was replaced): 20/20 pings, RTT p50 21.9 ms, p95 23.4 ms, max 23.4 ms; one-way about 11 ms. With no host poller running, 5/5 events persisted and were read afterwards.
- **B, sandbox to host loopback relay:** blocked by default (403). Needs an explicit policy allow rule; not pursued.
- **A, supported local-service routing:** no dedicated mechanism in `sbx` help beyond `ports` (host to sandbox). Not prototyped.
- Production hardening for C: per-ticket file path, append-only perms where possible, host-side schema and ticket/stage validation, bounded line size and file rotation, and a nonce or sequence number to detect truncation.

### 7 Evidence (`logs/07-evidence.log`)
Sandbox wrote four lines: a phase event, a valid `T1/impl` marker, a forged `T2/impl` marker and a `T1/done` marker. Host verifier (`06-bridge/verify-events.mjs T1 impl`) accepted exactly the valid one and rejected the others (`ticket T2 != T1`, `stage done != impl`), exit 0. Inside the sandbox: no `KARST_*` env, no SQLite or `karst*.db` file.

### 8 Ports (`logs/08-ports.log`)
Dev server in the sandbox, `sbx ports --publish 18123:8123`, host health check returned 200. Stop takes about 1 s. The mapping is hidden from `sbx ports` while the sandbox is stopped and returns on restart (curl 200). Karst must treat the listing as valid only while the sandbox runs.

### 9 Cleanup (`logs/09-cleanup.log`)
Stop 0.4 s; restart via exec 1.6 s. The script removes every sandbox whose name starts with `karst-spike-` (claude, codex; clone and gitmount had been removed earlier) and nothing else: an unrelated `bystander-spike-check` sandbox survived the loop and was removed afterwards by exact name. Worktree files remained, host canary hash unchanged. `sbx rm` needs `--force` without a TTY. Data dir 5.7 G before, 5.2 G after.

### 10 Extra: clone mode (`logs/10-git-clone.log`)
`sbx create --clone claude <repo>`: source mounted read-only, git works inside, a sandbox commit appears on the host as remote `sandbox-<name>/main` over a loopback git daemon. Edits are not live in the worktree. Leaves a remote in the host repo that must be removed with the sandbox (it was removed with `sbx rm`; the remote disappeared).

### 11 Extra: Codex boundary (`logs/11-codex-boundary.log`)
Same results as Claude: worktree write visible on host, sibling read/write blocked, `/Users` absent, own Docker daemon (`ba4343dd...`), `host.docker.internal` 403, `SBX_CRED_OPENAI_MODE=oauth`. `auth.json` 40 bytes; contents not read (credential read declined by the session safety classifier and not worked around).

### 12 Extra: shared `.git` mount (`logs/12-git-mount.log`)
`sbx create claude wt-a <repo>/.git`: git works and a sandbox commit is visible on the host branch. **Unsafe:** the sandbox wrote an executable `.git/hooks/post-commit` into the host repo and force-moved a branch not checked out elsewhere. Git itself refused to move a branch checked out in another worktree. Hooks run on the host at the next host git operation, which is an escape. Test hook and branch were removed.

## Latency and footprint

| Measure | Value |
|---|---|
| Create, first (image pull) | 103 s Claude, 61 s Codex; later creates seconds (images cached) |
| Stop | 0.4 to 1 s |
| Restart (exec on stopped) | 1.6 s |
| Bridge C round trip | p50 21.9 ms, p95 23.4 ms |
| Reattach, OAuth login | not timed |
| Disk | sandbox data dir about 5.2 to 5.7 G (shared images) |
| Memory | default 8 GiB limit, 10 CPUs auto; actual RSS not measured |

## Open questions from the plan

1. Transport: file polling works; a relay needs a policy rule.
2. Shared git metadata: not visible in direct mode; mounting it is unsafe (exp 12); clone mode is the tested safe path.
3. OAuth persistence: Claude via sandbox login; Codex via host `sbx secret set openai --oauth` (global).
4. Provider args: `--continue` and `resume --last` accepted; the full arg set Karst emits is untested.
5 to 8. Not answered (stop-on-close policy, orphan accounting, OS matrix, headless sandbox sharing).

## Not run or partial

VS Code terminal; Codex per-item timings and exact argv line; Linux and Windows; real Karst hook payloads; Codex `auth.json` contents; actual memory use; full provider arg set.

## Design §15 approval criteria

| Criterion | Status |
|---|---|
| Interactive I/O in Karst's VS Code terminal | PARTIAL (system terminal only) |
| Subscription OAuth, one Claude and one Codex | PASS |
| Close/reconnect and provider resume | PASS |
| Acceptable-latency lifecycle events | PASS (C, p95 23 ms RTT) |
| Authenticated stage marker without DB access | PASS with condition 2 (path binding plus host verification; the sandbox cannot authenticate itself) |
| Direct-mode edits visible on host | PASS for files; git needs clone mode (condition 1) |
| One published dev-server port | PASS |
| Host fs, host Docker, private IP, credential isolation | PASS (Claude); PASS-with-inference (Codex credentials) |
| Deterministic stop/remove/reconcile | PASS |

## Residual risk

Inside the sandbox the agent can still damage its own worktree and branch, send code out over allowed network hosts, and follow prompt injection from repo content. Autonomy trades per-command approval for diff review.

## Handoff

CONDITIONAL GO. The umbrella (T667) may spawn ST3 (plan Increment 1, `SessionRunner` seam, zero behavior change). Increments 2 and later stay gated on conditions 1 to 4. The umbrella should decide the direct-mode git question (borderline row above) before Increment 2.
