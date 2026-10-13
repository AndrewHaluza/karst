# Docker Sandbox Spike (Increment 0) Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run experiments 1-9 of Increment 0 (Claude + Codex only) and publish `spikes/docker-sandbox/RESULTS.md` with a GO / CONDITIONAL GO / NO-GO verdict.

**Architecture:** Disposable shell scripts under `spikes/docker-sandbox/`, one per experiment, each logging exact commands + output to `spikes/docker-sandbox/logs/NN-name.log`. `RESULTS.md` aggregates them. No production code, no `src/` edits, no extension wiring.

**Tech Stack:** `docker sandbox` CLI plugin (`github.com/docker/sandboxes/cli-plugin v0.6.0` seen on this host; the plan's `sbx` binary is NOT on PATH — record which entry point is used), bash, `curl`, Claude Code CLI, Codex CLI.

**Spec:** `docs/superpowers/specs/2026-07-28-docker-sandbox-agent-sessions-design.md`; experiment list `docs/superpowers/plans/2026-07-28-docker-sandbox-agent-sessions.md` §Increment 0 (executed verbatim; this file only sequences it). Platform research is closed: do not re-research E2B/Daytona/Modal.

## Global Constraints

- Timebox ~2 days. Stop and write a verdict when exhausted; unfinished experiments are recorded as `NOT RUN` with reason.
- No production code: only files under `spikes/docker-sandbox/` and this plan.
- Do not mutate user config: no `docker sandbox login`/config changes without noting it in RESULTS.md; use a throwaway sandbox name prefix `karst-spike-`.
- Never touch sandboxes not prefixed `karst-spike-`.
- Providers: Claude and Codex only.
- Scripts must not use `spawnSync`-style production patterns; they are bash, disposable.
- Interactive steps (OAuth login, TTY resize/interrupt) need the human; the executor must pause and ask via the ticket, never fake the result. Mark such evidence `MANUAL`.
- Verdict rules (verbatim): GO = all design §15 approval criteria pass or have bounded tested fix. CONDITIONAL GO = terminal/auth/isolation pass; bridge has one viable prototype with documented production hardening. NO-GO = subscription login, interactive terminal, safe evidence, or direct worktree behavior cannot be supported.
- Residual risk to restate in RESULTS.md: agent can still damage its worktree/branch, leak code over allowed network, follow prompt injection from repo content.

---

### Task 1: Scaffold + Experiment 1 (capability discovery)

**Files:**
- Create: `spikes/docker-sandbox/lib.sh`, `spikes/docker-sandbox/01-discovery.sh`, `spikes/docker-sandbox/logs/.gitkeep`

**Interfaces:**
- Produces: `lib.sh` exports `run()` (echo `$ cmd`, run it, tee to `$LOG`, record exit code) and `SPIKE_PREFIX=karst-spike-`. Later scripts `source "$(dirname "$0")/lib.sh"`.

- [ ] **Step 1: Write `lib.sh`**

```bash
#!/usr/bin/env bash
# Disposable spike helper. Not production code.
set -u
SPIKE_PREFIX=karst-spike-
SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${LOG:-$SPIKE_DIR/logs/$(basename "$0" .sh).log}"
mkdir -p "$SPIKE_DIR/logs"
: > "$LOG"
run() {
  echo "\$ $*" | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG"
  local rc=${PIPESTATUS[0]}
  echo "[exit $rc]" | tee -a "$LOG"
  return "$rc"
}
```

- [ ] **Step 2: Write `01-discovery.sh`**

```bash
#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
run uname -srm
run sw_vers
run docker --version
run which sbx
run docker sandbox version
run docker sandbox --help
run docker sandbox ls
run docker sandbox create --help
run docker sandbox run --help
run docker info --format '{{.OperatingSystem}} {{.ServerVersion}}'
```

- [ ] **Step 3: Run it**

Run: `bash spikes/docker-sandbox/01-discovery.sh`
Expected: log written; note login status, supported agents/templates, min macOS/Linux/Windows prerequisites from `--help`/docs links in output.

- [ ] **Step 4: Commit**

```bash
git add spikes/docker-sandbox
git commit -m "chore(spike): docker sandbox scaffold and capability discovery"
```

### Task 2: Experiments 2-3 (interactive Claude, interactive Codex)

**Files:**
- Create: `spikes/docker-sandbox/02-claude.sh`, `spikes/docker-sandbox/03-codex.sh`, `spikes/docker-sandbox/fixture.sh`

**Interfaces:**
- Consumes: `lib.sh` `run()`.
- Produces: `fixture.sh` creates `$TMPDIR/karst-spike-ws/{wt-a,wt-b}` as git worktrees of a throwaway repo (a stand-in for a Karst ticket worktree + sibling); prints `WT_A`, `WT_B`. Tasks 3-6 reuse it.

- [ ] **Step 1: Write `fixture.sh`**

```bash
#!/usr/bin/env bash
set -eu
ROOT="${TMPDIR:-/tmp}/karst-spike-ws"
rm -rf "$ROOT"; mkdir -p "$ROOT/repo"
git -C "$ROOT/repo" init -q -b main
echo seed > "$ROOT/repo/seed.txt"
git -C "$ROOT/repo" add . && git -C "$ROOT/repo" -c user.email=s@s -c user.name=s commit -qm seed
git -C "$ROOT/repo" worktree add -q "$ROOT/wt-a" -b a
git -C "$ROOT/repo" worktree add -q "$ROOT/wt-b" -b b
echo "WT_A=$ROOT/wt-a"; echo "WT_B=$ROOT/wt-b"
```

- [ ] **Step 2: Write `02-claude.sh`** — creates `karst-spike-claude` via `docker sandbox create claude "$WT_A"` (direct mount), prints the exact manual checklist, then pauses.

```bash
#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
eval "$(bash "$SPIKE_DIR/fixture.sh")"
run docker sandbox create --name "${SPIKE_PREFIX}claude" claude "$WT_A"
cat <<'EOF' | tee -a "$LOG"
MANUAL (record pass/fail + timing for each in RESULTS.md):
 a. docker sandbox run karst-spike-claude   -> subscription OAuth login completes (no API key)
 b. type a prompt; output streams
 c. resize terminal; UI reflows
 d. Ctrl-C interrupts a running turn, session survives
 e. exit; re-run `docker sandbox run karst-spike-claude`; reattach works
 f. kill the claude process inside (docker sandbox exec ... pkill claude); re-run with --continue/--resume; conversation resumes
 g. record the exact final claude argv (docker sandbox exec ... ps -o args= -C claude) and whether Karst-style extra args are accepted (open question 4)
EOF
```

- [ ] **Step 3: Write `03-codex.sh`** — identical shape with agent `codex`, name `karst-spike-codex`, and checklist item (g) = verify final effective Codex CLI args + subscription (ChatGPT) OAuth.

- [ ] **Step 4: Run each, perform MANUAL checklist with the user, paste observations into `logs/02-claude.notes.md` / `logs/03-codex.notes.md`**

Expected: each lettered item has PASS/FAIL + evidence.

- [ ] **Step 5: Commit**

```bash
git add spikes/docker-sandbox
git commit -m "chore(spike): interactive claude and codex experiments"
```

### Task 3: Experiments 4-5 (filesystem boundary, credential/Docker boundary)

**Files:**
- Create: `spikes/docker-sandbox/04-fs-boundary.sh`, `spikes/docker-sandbox/05-cred-docker.sh`

**Interfaces:**
- Consumes: sandbox `karst-spike-claude` (mounted on `WT_A`) from Task 2; `fixture.sh`.

- [ ] **Step 1: Write `04-fs-boundary.sh`**

```bash
#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
S="${SPIKE_PREFIX}claude"
ROOT="${TMPDIR:-/tmp}/karst-spike-ws"
x() { run docker sandbox exec "$S" sh -c "$1"; }
x "echo inside > '$ROOT/wt-a/written-in-sandbox.txt'"
run test -f "$ROOT/wt-a/written-in-sandbox.txt"          # visible on host
x "cat '$ROOT/wt-b/seed.txt'"                              # sibling read: expect FAIL
x "echo x > '$ROOT/wt-b/pwn.txt'"                          # sibling write: expect FAIL
x "ln -s / '$ROOT/wt-a/escape' && ls '$ROOT/wt-a/escape/Users' "   # symlink escape: expect no host data
x "ls \"\$HOME\"; ls /Users 2>&1; ls '$HOME/Library/Application Support/Code/User/globalStorage/karst.karst' 2>&1"
x "git -C '$ROOT/wt-a' log --oneline -1; cat '$ROOT/wt-a/.git'"   # open question 2: linked-worktree metadata
run test ! -e "$ROOT/wt-b/pwn.txt"
```

- [ ] **Step 2: Write `05-cred-docker.sh`**

```bash
#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
S="${SPIKE_PREFIX}claude"
x() { run docker sandbox exec "$S" sh -c "$1"; }
x "env | grep -iE 'anthropic|openai|token|key' || echo none"           # raw creds not in env
x "find / -xdev \\( -name '.credentials.json' -o -name auth.json \\) 2>/dev/null | head"
x "docker ps 2>&1 | head -3; docker info --format '{{.Name}} {{.ID}}' 2>&1"   # private daemon
run docker info --format '{{.Name}} {{.ID}}'                                # host daemon id to compare
x "ls /var/run/docker.sock 2>&1; curl -s --max-time 3 --unix-socket /var/run/docker.sock http://localhost/info | head -c 200"
x "curl -s --max-time 3 -o /dev/null -w '%{http_code}' http://192.168.0.1/ ; curl -s --max-time 3 http://host.docker.internal:80/ -o /dev/null -w '%{http_code}'"   # private IP / host reachability
```

- [ ] **Step 3: Run both; compare daemon IDs; record each expectation as PASS/FAIL**

Expected: sibling read/write and host-home access fail; worktree write visible on host; daemon IDs differ; no raw credentials found.

- [ ] **Step 4: Commit** `chore(spike): filesystem and credential boundary experiments`

### Task 4: Experiments 6-7 (lifecycle bridge candidates, evidence)

**Files:**
- Create: `spikes/docker-sandbox/06-bridge/` (`relay-server.mjs`, `poll-events.sh`, `06-bridge.sh`), `spikes/docker-sandbox/07-evidence.sh`

**Interfaces:**
- Produces: candidates A (supported local-service routing), B (authenticated published relay), C (host polling of append-only sandbox event file at `$WT_A/.karst-spike/events.ndjson`), each emitting `{ticket, stage, event, ts, nonce}` lines.

- [ ] **Step 1: Write candidate C poller + emitter**

```bash
# poll-events.sh (host)
tail -F "$1/.karst-spike/events.ndjson" | while read -r l; do echo "$(date +%s%3N) $l"; done
# emitter (inside sandbox), run 20x for latency
docker sandbox exec karst-spike-claude sh -c 'mkdir -p $WT/.karst-spike; for i in $(seq 20); do echo "{\"ticket\":\"T1\",\"stage\":\"impl\",\"event\":\"phase\",\"ts\":$(date +%s%3N),\"nonce\":\"$TOKEN\"}" >> $WT/.karst-spike/events.ndjson; sleep 0.2; done'
```

- [ ] **Step 2: Write candidates A and B.** A: use whatever `docker sandbox` offers for sandbox→host service routing (find in `--help` / Docker docs; record flag names). B: `relay-server.mjs` (node `http`, bearer token header, listens on a published port, logs received POSTs); emit from sandbox via `curl -H "Authorization: Bearer $TOKEN"`. Record whether sandbox→host reaches without exposing host localhost.

- [ ] **Step 3: Measure for each: median/p95 latency over 20 events, behavior when host receiver is down (events queued/dropped/errored).**

- [ ] **Step 4: Write `07-evidence.sh`** — over the selected candidate: send phase event; send impl-complete marker; attempt marker for other ticket/stage and confirm receiver rejects (token bound to ticket+stage); `docker sandbox exec ... 'find / -name "*.db" -o -name "*.sqlite*" 2>/dev/null | head; env | grep -i KARST_DB'` must show no Karst DB path.

- [ ] **Step 5: Pick bridge; document hardening needed for production. Commit** `chore(spike): lifecycle bridge and evidence experiments`

### Task 5: Experiments 8-9 (ports, cleanup)

**Files:**
- Create: `spikes/docker-sandbox/08-ports.sh`, `spikes/docker-sandbox/09-cleanup.sh`

- [ ] **Step 1: Write `08-ports.sh`**

```bash
#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
S="${SPIKE_PREFIX}claude"
run docker sandbox exec -d "$S" sh -c 'python3 -m http.server 8123 >/tmp/h.log 2>&1'
run docker sandbox ports "$S" --publish 8123:8123     # confirm exact subcommand via --help; adjust
run curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:8123/
run docker sandbox stop "$S"; run docker sandbox ls
run docker sandbox run "$S" -- true                    # restart
run docker sandbox ports "$S"                          # mapping persisted or must be reconciled?
run curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:8123/
```

- [ ] **Step 2: Write `09-cleanup.sh`** — record `docker sandbox ls` + `docker ps -a` + host file hash of an unrelated canary file before; stop/restart `karst-spike-claude` and time it; confirm `written-in-sandbox.txt` still on host; `docker sandbox rm` each `karst-spike-*` sandbox only; confirm worktree files remain, unrelated sandboxes/canary unchanged; record disk (`du -sh ~/.docker/sandboxes 2>/dev/null`) and memory (`docker stats --no-stream` or VM RSS) before/after, plus create/attach/reconnect latencies via `time`.

- [ ] **Step 3: Run; record PASS/FAIL. Commit** `chore(spike): ports and cleanup experiments`

### Task 6: RESULTS.md and verdict

**Files:**
- Create: `spikes/docker-sandbox/RESULTS.md`

- [ ] **Step 1: Write RESULTS.md** with sections in this order: Environment (host OS, arch, docker, plugin version, `sbx` presence), Experiment 1..9 (each: exact commands, result PASS/FAIL/NOT RUN/MANUAL, evidence link to `logs/`), Selected bridge mechanism, Blockers + workarounds, Latency table (create/attach/reconnect/bridge), Footprint (disk/memory), Open questions 1-8 answered or marked unresolved, Design §15 criteria checklist (9 items, pass/fail), Residual risk, **Verdict** (one of GO / CONDITIONAL GO / NO-GO per Global Constraints rules, with reason), **Handoff** (GO/CONDITIONAL: "umbrella T667 may spawn ST3 = Increment 1 SessionRunner seam"; NO-GO: "ST3 deferred because <reason>").

- [ ] **Step 2: Self-check** — every experiment 1-9 has a section; every §15 criterion has a line; no `TBD`; verdict matches rule text.

- [ ] **Step 3: Commit**

```bash
git add spikes/docker-sandbox
git commit -m "docs(spike): docker sandbox feasibility results and verdict"
```

---

## Self-Review

- Spec coverage: experiments 1-9 → Tasks 1-5; spike record items (OS/versions, commands, results, bridge, blockers, latency, footprint, verdict) → Task 6; §15 criteria mapped in Task 6; open questions 2, 4 covered in Tasks 2-3, others listed in Task 6.
- Known gap: OAuth login, TTY resize and interrupt cannot be automated; Tasks 2 requires the human. If the user is unavailable, record `MANUAL – NOT RUN`, which caps the verdict at CONDITIONAL GO at best and NO-GO if login cannot be proven.
- Host finding: `sbx` binary absent; `docker sandbox` plugin v0.6.0 present. Command names above (`ports`, `exec`, `--publish`) are best-effort; Task 1 output decides the real flags, and scripts must be adjusted to match before running.
