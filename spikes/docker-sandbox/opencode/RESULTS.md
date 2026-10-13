# opencode Docker sandbox feasibility spike (ST2b) — results

Ticket: ST2B-OPENCODE-DOCKER-SANDBOX (T682, D175). Companion to ST2 (`spikes/docker-sandbox/RESULTS.md`, Claude and Codex, via `sbx`). Date 2026-10-13. Scripts and raw logs: this directory and `logs/`. Spike only, no production code.

## Verdict

| OS | Verdict | Basis |
|---|---|---|
| macOS (arm64, Docker Desktop 29.1.3) | **CONDITIONAL GO** | Exps 1, 2, 4, 5, 6, 7, 8, 9 live PASS for opencode v1 and v2. Exp 3 PASS at pty level, VS Code terminal run still MANUAL. |
| Linux | **CONDITIONAL GO, UNVERIFIED live** | No Linux host or CI runner was available in this session. `linux-ci.sh` is a credential-free script for it. The image is the same Debian userland, so risk is low. Linux-only issue: bind-mount uid/gid (see blocker 5). |
| Windows | **UNVERIFIED (desk-check only)** | No machine. See exp 10. |

Plain `docker run` (no `sbx`) is enough. opencode needs no Docker-specific support. Plain Docker is also the only route here where a network **allowlist is enforceable**.

## Blockers and conditions (carry to the runner ticket)

1. **Shared `.git` must be mounted read-write for commits, and that is a host-code-execution path.** An agent can plant `.git/hooks/post-commit` and the host's next commit runs it (exp 7C reproduced: `PWNED`). Condition: mount `hooks/` and `config` read-only over the rw common dir (exp 7D: hook write refused, commit still works). Also still exposed: all refs/branches and other worktrees' metadata. Alternative: ST2's clone mode (no live commits).
2. **v2 credentials live in v2's own store, not `auth.json`.** With karst's isolated XDG dirs a fresh store prints `No authenticated integrations`, even with `auth.json` mounted at `$XDG_DATA_HOME/opencode/`. Seed it with `opencode auth import` (reads stdin) from the host's `auth export` output. A persisted data volume keeps it. `auth export` prints secrets, so the runner must pipe it and never log it.
3. **Mounting a single file creates root-owned parent dirs** in the container (`EACCES: mkdir .../opencode/repos`). The image must pre-create the data dirs owned by `node`, and the data dir must be a volume or tmpfs with the file mounted on top.
4. **Allowlist needs a sidecar.** Docker alone is on/off. A domain allowlist = `--internal` network + CONNECT proxy sidecar (exp 8). Proxy env vars are advisory, but the internal network enforces them (no route out).
5. **Linux uid mapping** (UNVERIFIED): bind mounts keep host ownership. Run with `--user $(id -u):$(id -g)` and a writable `HOME`, or commits/writes fail.
6. **Bind-mount speed on macOS (and likely Windows)**: file-heavy git ran about 13x slower than in-container storage (exp 9).
7. **Provider key in env is visible to the agent** (it is the agent's own process). Prefer a scoped, revocable key; see exp 2.

## Environment

macOS 26.6.2 arm64, Docker Desktop 29.1.3 (`desktop-linux`), image `node:22-bookworm-slim` (Node 22.23.3, git 2.39.5), opencode **v1 `opencode-ai@1.19.0`** (Bun 1.3.14) and **v2 `@opencode/cli@2.0.27`** installed to separate prefixes as `opencode1` / `opencode2` (v1 and v2 both ship a launcher named `opencode`; same trap as `opencode2Binary.ts`). Model for live calls: `opencode-go/deepseek-v4-flash`. `Dockerfile`, `lib.sh` (auth + volume mounts).

## Experiments

| # | Experiment | Result |
|---|---|---|
| 1 | Image | PASS |
| 2 | Auth | PASS (file mount for v1 and v2, env key for v1); see blockers 2, 3, 7 |
| 3 | TUI | PASS at pty level; VS Code terminal MANUAL pending |
| 4 | Headless | PASS |
| 5 | Resume | PASS |
| 6 | opencode2 permission + XDG | PASS (with blocker 2) |
| 7 | Filesystem | PASS, with blocker 1 |
| 8 | Network | PASS; allowlist enforceable via proxy sidecar |
| 9 | Child processes + ports | PASS; speed risk |
| 10 | Windows | UNVERIFIED desk-check |

### 1 Image (`logs/01-image.log`)
`docker build -t oc-spike .`; `opencode1 --version` → `1.19.0`; `opencode2 --version` → `opencode v2.0.27`; git 2.39.5; node v22.23.3; runs as uid 1000 `node`. Image 671 MB (single layer set, `linux-arm64` optional dep resolved by npm). PASS. Pin both versions by `ARG OC1/OC2`; karst's fixture is 2.0.24 and accepts newer with a warning.

### 2 Auth (`logs/02-auth-a.log`, `02-auth-b.log`)
- Host home not visible: `/Users` absent, `/home/node` holds only dotfiles, `~/.local/share/opencode` missing. PASS.
- Read-only file mount of `auth.json` over a writable data volume: `opencode1 auth list` shows OpenCode Go and OpenRouter; `opencode1 models` lists 30+ `opencode-go/*`; `opencode2 auth list` shows both. Writes to the file fail (`Read-only file system`). PASS. (A bare file mount without the volume failed, blocker 3.)
- Env key: `-e OPENROUTER_API_KEY=…` shows up as an environment credential in v1 and a real request reached OpenRouter (it returned the account's monthly key-limit error, so transport and key delivery work; the exact limit message is not logged). A successful completion over the env route was therefore not shown. Note the log for this run was overwritten; the finding is from the first run of `04` only.
- Comparison: file mount keeps the secret out of `docker inspect`/`ps` env and is read-only to the agent process, but the agent can still read it. Env keys appear in `docker inspect` and child-process env. Both expose the secret to the agent. Neither beats a scoped key. File mount also works for the `opencode-go` provider, which has no documented env var. Recommend: file mount (v1) / `auth import` (v2).

### 3 TUI (`03-tui-pty.py`, `logs/03-tui-pty.log`)
Drove `docker run -it` under a pty for v1 and v2: TUI rendered (10-14 KB), truecolor escapes present (`38;2`), terminal resize (30x100 → 40x140) triggered a redraw (11 KB), typed input echoed. `^C` did not exit the TUI (it clears input; same as native). **Not done:** a run in the real VS Code terminal (visual check, mouse, paste). User to confirm manually: `docker run --rm -it -e TERM -e COLORTERM -v oc-data:/home/node/.local/share/opencode -v <auth>:…:ro oc-spike opencode2 --standalone`.

### 4 Headless (`logs/04-headless.log`)
`opencode1 run -m … "Reply with exactly: PONG1"` → `PONG1`, rc 0. v2: prompt on stdin, `opencode2 run --standalone -m …` → `PONG2`, rc 0 (karst's stdin-only rule holds). Bad model `nope/none` → rc 1. Output arrives on stdout (ANSI in a TTY, plain otherwise); capture works with `docker run` stdout. PASS.

### 5 Resume (`logs/05-resume.log`)
v1: container 1 told a codeword; new container with the same data volume `run -c` answered `ZEBRA42`. Control without the volume: "no codeword". v2 same with `QUOKKA7`. Persistence is the `opencode.db` in the data volume. PASS. The runner must keep one volume per karst session (or per ticket) and key it.

### 6 opencode2 config and XDG (`logs/06-*.log`)
- `OPENCODE_CONFIG_CONTENT` with `permission:{"*":"allow","shell":"deny","bash":"deny"}`: the agent answered `DENIED` and no file was written. Control with `"*":"allow"`: file written. The config-content permission object works inside the container. PASS.
- XDG: with `XDG_{DATA,CONFIG,STATE,CACHE}_HOME=/xdg/...` on tmpfs, all v2 writes land there (`opencode.db`, `log`, `repos`, `shell`, cache `bin`), the default `~/.local/share`, `.config`, `.cache` stay empty. PASS. `OPENCODE_DISABLE_AUTOUPDATE=1` accepted.
- Credential trap: see blocker 2 (`logs/06-opencode2-auth-store.log`). After `auth import` the fresh XDG store lists both credentials (`06-opencode2-import.log`). An empty store also gave `Model unavailable`/`exo-free deprecated` errors, which look like a model problem but are a credential problem.

### 7 Filesystem (`07-fs.sh`, `logs/07-fs.log`)
Throwaway repo + linked worktree, mounted at the same absolute paths.
- A: worktree only → `fatal: not a git repository` (reproduces ST2 condition 1).
- B: worktree + `.git` common dir rw → `git status` ok, commit succeeds, host sees `agent-commit` on `feat`. Write outside the mounts and read of a sibling dir fail (`Permission denied`, `No such file`). `/etc` write fails (non-root). PASS.
- C: with `.git` rw, a planted `post-commit` hook ran on the host. Blocker 1.
- D: `hooks/` and `config` mounted ro → hook write `Read-only file system`, `git config` write refused, commits still work. Mitigation holds for these two paths. Not checked: other executable config, e.g. `.git/info/attributes` filters and `core.fsmonitor` set in the (now ro) config are covered, `worktrees/*/config.worktree` is not.
- Same-path mounting is needed because the `.git` file stores an absolute host path. On Windows this path rewrite is the main problem (exp 10).

### 8 Network (`logs/08-network.log`)
- Default bridge: `registry.npmjs.org`, `github.com`, `pypi.org`, `opencode.ai`, `models.dev`, `openrouter.ai` all 200 (provider traffic goes via `opencode.ai`/`models.opencode.ai` for opencode-go).
- `--network none`: blocked (opencode would then work only with a host-side provider).
- Allowlist: `docker network create --internal` + a proxy sidecar on a second network (`allowlist-proxy.mjs`, CONNECT allowlist). Agent container saw npm 200, pypi/example.com blocked (proxy 403), direct `--noproxy` blocked (no route). `HTTPS_PROXY` is honored by opencode v1 (Bun): the headless run succeeded and the proxy log shows only `opencode.ai`, `models.opencode.ai`, `registry.npmjs.org`. PASS. Plain Docker alone is only on/off; the allowlist is enforceable with the sidecar topology. v2 through the proxy not run. Proxy here is a 20-line spike, not production (no DNS pinning, SNI-only).

### 9 Child processes and ports (`logs/09-child-procs.log`, `09b-…log`)
- `node --test` in the container: pass 1, rc 0. opencode's own shell tool ran the same test (`Pass count: 1`).
- Dev server in the container, `-p 127.0.0.1:18123:8123` → host `curl` returned `uat-ok`; the LAN address was unreachable (loopback-only publish works).
- Speed (6000 files, `git status` x5): host 0.12 s, container bind mount 0.73 s, container local fs 0.056 s. Risk, not a blocker; mitigate by keeping `node_modules`/build output in a named volume.
- Not tested: running karst's real `vitest` suite (native `better-sqlite3` needs a Linux ABI build in the image or volume), docker-in-docker (none, by design).

### 10 Windows desk-check (all UNVERIFIED, nothing run)
- **Engine**: Docker Desktop with WSL2 backend (UNVERIFIED). The WSL2 distro must be enabled; Windows containers mode is not usable (Linux image).
- **Paths**: `C:\Users\x\wt` can be passed as `-v C:\Users\x\wt:/work` or `/c/Users/...`; WSL sees it as `/mnt/c/...`. The worktree's `.git` file holds a Windows or WSL absolute path (depends on which git created it); the in-container path must equal that string, or git must be told the mapping. Same-path mounting (exp 7) is impossible for `C:\` paths on Linux. Candidate fix: mount to `/mnt/c/...` and rewrite the pointer files (`.git`, `.git/worktrees/*/gitdir`) via a git `--separate-git-dir`/`worktree repair` call inside the container, or run git on the host. UNVERIFIED.
- **Speed**: `/mnt/c` bind mounts through 9P are far slower than the native WSL ext4 (commonly an order of magnitude; our macOS number is 13x). Keep the worktree inside the WSL filesystem if possible. UNVERIFIED.
- **Other**: line endings (`core.autocrlf`) between Windows git and container git; file modes on `/mnt/c`; the extension host's Docker CLI path (`docker.exe`) and quoting; TTY/resize through `docker.exe` in the VS Code terminal. All UNVERIFIED.

## Inputs for the 'opencode on the Docker runner' ticket

1. **Image**: `Dockerfile` here (node:22-bookworm-slim, git, opencode v1 and v2 under separate names, non-root `node`, pre-created data dirs). Pin versions by build arg; add test tooling per repo.
2. **Mounts**: worktree and its `.git` common dir at identical absolute paths, with `hooks/` and `config` ro (blocker 1); per-session named data volume at `~/.local/share/opencode`; ro `auth.json` (v1) or one-time `auth import` into the volume (v2).
3. **Env** (v2, from `opencode2Binary.ts`): the four `XDG_*` into container paths on the volume/tmpfs, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DISABLE_AUTOUPDATE=1`; headless with stdin prompt and `--standalone`. The container is the enforcement; the permission object stays as defence in depth.
4. **Network**: default off-the-shelf is on/off. Allowlist = internal network + proxy sidecar; allowlist at least `opencode.ai`, `models.opencode.ai`, `openrouter.ai`, `models.dev`, `registry.npmjs.org`. Port publish `127.0.0.1:<host>:<container>` for UAT.
5. **User**: `--user $(id -u):$(id -g)` on Linux (UNVERIFIED), uid 1000 on macOS Docker Desktop.
6. **Lifecycle**: stop/cleanup = `docker rm -f` plus the session volume; use label filters, never name patterns.
7. **Open**: VS Code terminal run (exp 3), Linux live run via `linux-ci.sh`, v2 through the proxy, real vitest suite in the container, Windows path rewriting.
