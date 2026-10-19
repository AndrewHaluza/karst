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
END_DOC_BLOCK: [@issue:GATE-02]
