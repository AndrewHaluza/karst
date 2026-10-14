<!-- AGENT INSTRUCTIONS:
This file uses an agent-optimized block format. DO NOT read this file entirely.
1. TABLE OF CONTENTS: Run this to list all available keys:
  grep -F "## [@" docs/guides/sandbox-backends.md

2. EXTRACT A RULE: Run this to read a specific block (Example for ID 'guide:SBB-01'):
  awk "/^## \[@guide:SBB-01\]/,/END_DOC_BLOCK: \[@guide:SBB-01\]/" docs/guides/sandbox-backends.md
-->

# Sandbox backends: using `agentBackends`

How to run agent sessions inside a sandbox so they ask for fewer permissions.
The design rules are in `arch:AC-31` (fail closed), `arch:AC-32` (sbx), `arch:AC-33`
(docker) and `arch:AC-35` (the UI). This guide is the user-facing setup.

## [@guide:SBB-01] Choose a backend

Set it in **Settings → Agents → Sandbox backend**, or `agentBackends:` in `karst.yml`, one entry per core
(`claude: sbx`, `opencode: docker`; an absent core is `host`; agy is host only).
It is opt-in. `host` is the default and keeps today's prompted behaviour.
The old single `agentBackend:` value is still read as a fallback, but Settings
writes only the map.

| Backend | Cores | Needs |
|---|---|---|
| `host` | all | nothing |
| `sbx` | claude, codex | Docker Sandboxes (`sbx`), signed in, a network policy |
| `docker` | opencode, opencode2 | Docker, a reachable daemon |

A core the backend cannot run (for example agy) stays on the host, prompted. The
"effective backend" line under the selector shows each core's result.

An unavailable backend never blocks a session and never grants broad permissions.
The session runs prompted on the host and says why: `Karst: <ticket> running
prompted on host: <reason>`.

A ticket can opt OUT of the project backend (ticket form → *Sandbox backend* →
*Host*). It can never opt in to a backend the project did not choose.
END_DOC_BLOCK: [@guide:SBB-01]

## [@guide:SBB-02] Prerequisites and login

Check **Settings → Agents** (status under the selector) or run `karst doctor`.
Each failure names its fix.

- **sbx**: install Docker Sandboxes so `sbx` is on `PATH`. Run `sbx login`, then
  `sbx policy init` (a network policy must exist).
  - claude: log in inside the sandbox on its first `sbx run`.
  - codex: run `sbx secret set openai --oauth` once. Karst never runs this for you.
- **docker**: start the Docker daemon. The image `karst/opencode-sandbox:<v1>-<v2>`
  is built locally on first use (it can take minutes) and is never pulled.
  - opencode: a host `auth.json` is mounted read-only when present.
  - opencode2: karst streams `auth export --standalone` into the sandbox; the
    credential never becomes a string in karst. Prefer a scoped, revocable key.
END_DOC_BLOCK: [@guide:SBB-02]

## [@guide:SBB-03] Clone mode and the trust boundary

A sandbox works on a CLONE of the ticket branch. It never mounts the host worktree
or its shared `.git`, so a hook the agent plants cannot run on the host.

- The agent commits inside the sandbox. The host worktree does not change.
- **Sync** fetches the sandbox commits and fast-forwards the ticket branch. A
  non-fast-forward is refused, never forced.
- **Open diff** shows what a sync would bring in (`git diff HEAD...<sandbox ref>`)
  in a read-only editor. Nothing is merged.
- Treat sandbox commits as untrusted input: read the diff before you rely on them.

Residual risk: the agent can still damage its own branch, leak code over an allowed
domain, and follow prompt injection from repo content. A sandbox trades per-command
approval for diff review.
END_DOC_BLOCK: [@guide:SBB-03]

## [@guide:SBB-04] Ports, services and network

- The network is an allowlist: sbx uses its network policy; docker uses a proxy on
  an internal network. Package registries and the provider API are allowed.
- Services start inside the sandbox. Only declared service ports are published, on
  `127.0.0.1` only. A host-port conflict reallocates the host side once.
- Docker ignores `-p` on an internal network, so each published port gets a small
  relay container.
- Baseline services stay on the host. Only their declared default ports are
  reachable from the sandbox.

Troubleshooting:

- *Service unreachable*: check that the sandbox exists and is running (dashboard
  Sandbox card, or `sbx ls` / `docker ps`). A stopped docker container cannot host
  a service.
- *Package install fails*: the host is probably not on the allowlist. Do not widen
  the policy for one ticket; use an allowed registry or mirror.
- *Port in use*: stop the other service, or let karst reallocate the host port.
END_DOC_BLOCK: [@guide:SBB-04]

## [@guide:SBB-05] Dashboard actions and cleanup

The ticket dashboard shows a **Sandbox** card under a sandbox backend: backend,
core, workspace mode and network profile.

- **Sync**, **Open diff**: see `guide:SBB-03`.
- **Stop**: stops the sandbox and keeps it for the next open. Karst also stops a
  sandbox when the ticket is done and after a long idle time.
- **Remove**: syncs first. If commits cannot be synced it asks, and *Cancel* keeps
  the sandbox. Archiving a ticket and switching its core use the same guard.

Disk: **karst doctor** lists the sandbox count and an approximate docker size and
warns above 10 GB. To free space, remove finished sandboxes from the dashboard, or
run **Karst: Clean Up Orphan Sandboxes** for sandboxes whose ticket is gone.
END_DOC_BLOCK: [@guide:SBB-05]
