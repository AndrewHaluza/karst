<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
   grep -F "## [@" docs/issues/2026-10-19-sandbox-gate-capabilities.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'issue:GATE-01'):
   awk "/^## \[@issue:GATE-01\]/,/END_DOC_BLOCK: \[@issue:GATE-01\]/" docs/issues/2026-10-19-sandbox-gate-capabilities.md
-->
# The UAT gates could not RUN in the sandbox (2026-10-19)

The UAT gate run of ticket 706 (2026-10-19, attempt 2) reported four red
gates. None of them was the ticket's code: every one of them was a command
that is not installed in the environment the gates ran in.

| gate | exit | what it reported |
| --- | --- | --- |
| unit | 1 | `node-gyp` — "Could not find any Python installation to use" |
| integration | 1 | the same rebuild failure |
| visual | 127 | `sh: 1: docker: not found` |
| layout | 127 | `sh: 1: docker: not found` |

## [@issue:GATE-01] What the run actually hit

The gates of a sandboxed ticket run inside the ticket's sandbox
(`workflow/gates/sandboxGates.ts`, arch:AC-32), and the karst opencode
sandbox image is `node:22-bookworm-slim` plus opencode: no docker, no
python3, no compiler.

| need | why | available in the sandbox |
| --- | --- | --- |
| docker | `test:visual:docker` and `test:layout:docker` run the sweep in the pinned Playwright image — the screenshot baselines are recorded there and are valid for exactly that rendering environment | no docker binary, and no docker socket is ever mounted |
| python3 + a C++ compiler | `better-sqlite3` publishes no prebuild for linux-arm64, so `rebuild:node` falls back to a source build, and node-gyp runs on Python | neither, in a slim image |

Two consequences, both of them invisible before the fix: the unit gate
reported a **build** failure where the truth is a missing toolchain, and the
visual/layout gates reported a **red** the ticket could not clear — a
container-pinned gate has no meaning outside the container.
END_DOC_BLOCK: [@issue:GATE-01]

## [@issue:GATE-02] The repair

Two halves, one on each side of the boundary.

**In the repo.** A gate that could not RUN its command now says so and is
classified as such. `scripts/rebuild-better-sqlite3.mjs` probes for Python,
make and a C++ compiler before a source build and exits 127 with the apt line
when one is missing; `scripts/dockerGate.mjs` wraps the container-pinned gate
scripts and exits 127 with the docker repair when docker is absent. UAT and
review treat exit 127 as a missing capability and PARK (`capability-missing`,
no fix attempt consumed) instead of failing the ticket — the rule is
@arch:GATE-CAPABILITY.

**In the sandbox image.** The image is built from `sandbox/opencode/Dockerfile`,
so the capabilities a repository's gates need are a repository change:

- a C++ toolchain and Python, so `rebuild:node` can build the addon that has
  no published linux-arm64 prebuild;
- the pinned Playwright browser, and the fonts and fontconfig rules of the
  environment the visual baselines were recorded in, so a sweep here renders
  the pixels the baselines hold. The image marks that environment with
  `/opt/karst/visual-baseline-env`, and `scripts/dockerGate.mjs` reads the
  marker to decide whether a local sweep may stand in for the container —
  only there, because anywhere else a local sweep answers a different
  question.

The image tag carries the Playwright release and a revision, so a host
rebuilds it instead of reusing the one it has.

**Docker hardening detail** (moved from `@arch:AC-33` to keep that block under
the 6200 B cap): the helper containers use the same `--cap-drop ALL
--security-opt no-new-privileges` as the agent container (chown keeps only
`CHOWN`); bind paths containing `,` or a newline are refused; a failed prepare
stops the proxy, so no egress stays up.

**Linux and Windows detail** (also moved from `@arch:AC-33`): Linux runs
`--user <uid>:<gid>` from `process.getuid()`/`getgid()` (never shell
expansion), with a `HOME` tmpfs owned by that uid and new volumes chowned to it
once, as root inside a throwaway container (blocker 5). Windows is desk-checked
only (ST2B exp 10) and needs Docker Desktop + WSL2; clone mode avoids the `C:\`
→ `/mnt/c` worktree rewrite, but the bundle temp dir is still a bind mount, and
bind-mount speed and path translation are untested.
END_DOC_BLOCK: [@issue:GATE-02]

## [@issue:GATE-03] How to run these gates today

The four gates are the repository's own scripts, and on a host that has docker
they all run — that is where they belong, and where the host run of this
ticket already passed (the only red was the stale agents-page baselines, since
repaired).

| gate | command | on a host with docker |
| --- | --- | --- |
| unit | `npm run test:unit` | the published prebuild matches the host's Node, so the rebuild is a no-op |
| integration | `npm run test:integration` | same |
| visual | `npm run test:visual:docker` | the sweep runs in the pinned Playwright container, which is where the baselines were recorded |
| layout | `npm run test:layout:docker` | same, with the layout ledger's authoritative env |

In the karst sandbox the same four commands need the capabilities the image
now carries, so they pass there once this branch is merged and the extension
is rebuilt (the extension ships the image's context, and the gate container
runs the tag the extension names). Until then a sandboxed ticket's gates exit
127 and the stage parks with @arch:GATE-CAPABILITY — a park, not a red the
ticket can clear.
END_DOC_BLOCK: [@issue:GATE-03]

## [@issue:GATE-04] The image claimed the baseline environment and did not carry it (2026-10-21)

The UAT run of ticket 721 (2026-10-21, attempt 1) was red on three gates and
none of it was the ticket's code. The image revision `r2` had four defects,
all in `sandbox/opencode/Dockerfile` or the container's run args:

| symptom | cause | repair (`r3`) |
| --- | --- | --- |
| every full-page screenshot differs by ~0.01 of its pixels, on pages the change never touched; `layout-ledger` reports text a few px wider | the font trees were `COPY`d from the pinned Playwright image BEFORE `playwright install --with-deps`, whose apt step installs THIS distro's faces over them: bookworm's `fonts-liberation 1.07` and `fontconfig-config 2.14` instead of noble's `2.1.5`/`2.15` (`dpkg -S` names the Debian packages as the owners). Different advance widths, so text wraps differently | the wipe + copy now runs AFTER the browser install, and wipes `/usr/share/fonts`, `/usr/share/fontconfig` and `/etc/fonts` first so a distro-only face cannot survive beside the baseline's |
| `listenerPids` returns `[]`, so port reclaim refuses and the port/supervisor suites read "no listener" | no `lsof` in the image (`apt-get install` listed `procps` but not `lsof`), and lsof is how `runtime/portConflict.ts` names the process holding a port | `lsof` is installed |
| `expected [Function] to throw` — a tree killed by its process group is still "alive" | no init: PID 1 is the agent or the gate, neither reaps, so the last descendant reparents to PID 1 and stays a ZOMBIE; `process.kill(pid, 0)` answers for it forever | `--init` (tini) on the containers that host repo processes — `REAPER` in `dockerRunArgs.ts`, deliberately not part of `HARDENING` |
| `git commit` in a scratch repo: "Please tell me who you are" | the ticket clone gets the host identity from `git clone --config user.name=…`, but a repo a gate creates in `/tmp` has none | `git config --system user.name/user.email` in the image |

Reading the gate log matters more than the gate's colour: the failing test
names (`portConflict`, `supervisor`, `gates/run`, `snapshot`) had nothing to
do with the ticket's quota reader, and every quota test passed. `r3` takes a
rebuild — the tag carries the revision, so a host builds it instead of reusing
`r2`.

END_DOC_BLOCK: [@issue:GATE-04]
