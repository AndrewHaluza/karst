# Docker Sandbox agent sessions — incremental integration plan

Ticket: `869eanxvh`

Status: ready for feasibility spike; production implementation is gated.

Design:
[Docker Sandbox agent sessions](../specs/2026-07-28-docker-sandbox-agent-sessions-design.md)

Research:
[Agent sandbox platform research](../specs/2026-07-28-agent-sandbox-platform-research.md)

## Goal

Add an optional Docker Sandbox execution backend while preserving Karst's
current interactive terminal, provider resume, approach, lifecycle, worktree,
port, and archive behavior.

## Non-goals

- implementing a generic OCI/microVM runtime;
- adding E2B, Daytona, or Modal in this increment;
- making clone mode the initial workflow;
- exposing Karst's SQLite registry inside the sandbox;
- changing stage-machine semantics;
- silently replacing host execution;
- supporting every agent provider before Claude and Codex are proven.

## Delivery strategy

Proceed through explicit gates:

```text
Spike
  -> runner seam with no behavior change
    -> Docker interactive MVP
      -> hook/evidence bridge
        -> ports and lifecycle
          -> guarded rollout
```

Do not begin the next increment when its predecessor's exit criteria fail.

## Increment 0 — feasibility spike

### Purpose

Prove external product behavior before restructuring Karst.

### Deliverable

Create a disposable, non-production harness under a clearly experimental
location such as `spikes/docker-sandbox/`. It may invoke `sbx` directly and
record exact commands and observed versions. Do not route production extension
actions through it.

### Experiments

1. Capability discovery
   - detect `sbx`;
   - record `sbx` version;
   - check login and supported templates without mutating user configuration;
   - identify supported macOS, Linux, and Windows prerequisites.
2. Interactive Claude
   - start from a Karst ticket worktree in direct mode;
   - authenticate with a subscription-compatible flow;
   - type prompts, receive streamed output, resize, and interrupt;
   - close and reattach;
   - terminate the provider and resume the conversation.
3. Interactive Codex
   - repeat the Claude checks;
   - verify final effective CLI arguments and subscription OAuth.
4. Filesystem boundary
   - write inside the worktree;
   - attempt a sibling-worktree read/write;
   - attempt a symlink escape;
   - verify the host home and Karst global storage are unavailable.
5. Credential and Docker boundary
   - verify provider requests authenticate;
   - verify raw provider credentials are not readable;
   - verify the sandbox uses its private Docker daemon;
   - verify the host Docker daemon is unreachable.
6. Lifecycle bridge candidates
   - test supported local-service routing;
   - test an authenticated published relay;
   - test host polling of an append-only sandbox event file;
   - measure latency and failure behavior.
7. Evidence
   - report a phase event;
   - report an impl-complete marker;
   - attempt another ticket/stage and verify rejection;
   - verify no DB path is present in the sandbox.
8. Ports
   - start a simple HTTP server in the sandbox;
   - publish through `sbx`;
   - health-check it from the host;
   - restart and verify/reconcile the mapping.
9. Cleanup
   - stop and restart the named sandbox;
   - remove it;
   - verify worktree changes remain;
   - verify unrelated sandboxes and files remain untouched.

### Spike record

Produce `spikes/docker-sandbox/RESULTS.md` with:

- host OS and versions;
- exact commands;
- results for every experiment;
- selected bridge mechanism;
- blockers and workarounds;
- measured create/attach/reconnect latency;
- approximate VM disk/memory footprint;
- go/no-go verdict.

### Exit criteria

- GO: all design approval criteria pass or have a bounded, tested fix.
- CONDITIONAL GO: terminal/auth/isolation pass; bridge has one viable prototype
  with documented production hardening.
- NO-GO: subscription login, interactive terminal, safe evidence, or direct
  worktree behavior cannot be supported.

## Increment 1 — introduce `SessionRunner`

### Goal

Separate provider command construction from execution location with zero
behavior change.

### Likely files

- add `src/agent/sessionRunner.ts`;
- add `src/agent/hostSessionRunner.ts`;
- update `src/agent/adapter.ts` only for neutral launch data if required;
- update `src/ui/session.ts`;
- update extension composition roots and fakes;
- add focused runner/session tests.

Actual file selection must follow code discovery at implementation time.

### TDD sequence

1. RED: existing session test asserts the runner receives ticket identity and
   provider-built command.
2. GREEN: implement `HostSessionRunner` that returns/preserves today's command.
3. RED: focus/reopen tests prove no duplicate terminal launch.
4. GREEN: route current host behavior through the runner.
5. RED: headless execution contract tests, if included in this increment.
6. GREEN: add the smallest neutral seam; do not introduce Docker branches in
   `SessionManager`.

### Exit criteria

- all existing host-session behavior is unchanged;
- provider-specific syntax remains in adapters;
- `SessionManager` does not import Docker or inspect provider names;
- typecheck, unit tests, and build pass;
- no synchronous process execution enters the extension host path.

## Increment 2 — Docker runner interactive MVP

### Goal

Open, focus, stop, and reattach a named Docker-backed Claude or Codex terminal.

### Components

- `DockerSandboxRunner`;
- injectable asynchronous `SbxRunner` process seam;
- stable sandbox-name formatter;
- capability/preflight result type;
- execution-backend resolver;
- experimental manifest setting and write overlay;
- dependency diagnostics;
- fake `sbx` test harness.

### Requirements

- never compose a shell string; pass executable and argv separately;
- reject unsafe names and paths defensively;
- use the ticket worktree as the only direct workspace;
- disable shared skills;
- surface the effective backend in session diagnostics;
- preserve adapter model, approach, prompt, and resume arguments;
- never silently fall back from Docker autonomous mode to host bypass mode.

### Tests

- exact argv for fresh Claude/Codex launches;
- reattach by stable name;
- equal ticket keys in separate projects produce different names;
- paths with spaces remain one argv element;
- missing/unhealthy `sbx` returns actionable availability;
- creation failure does not set agent live;
- existing live VS Code terminal is focused;
- terminal close does not delete the sandbox;
- explicit removal targets exactly one sandbox.

### Exit criteria

- manual F5 session supports typing and follow-ups;
- direct worktree edits appear in VS Code;
- close/reopen attaches to the expected named sandbox;
- provider session resume works after provider exit;
- host backend remains green and default.

## Increment 3 — lifecycle and evidence bridge

### Goal

Restore Karst live status and workflow evidence without exposing the registry.

### Components

- per-launch capability issuer;
- sandbox hook configuration targeting the selected bridge;
- host receiver/collector;
- event schema with strict discriminated unions;
- project/ticket/launch binding validation;
- expiry and replay handling;
- bridge reconciliation and cleanup.

### Security tests

- valid session event reaches only its ticket;
- forged ticket/project/launch is rejected;
- duplicate marker is idempotent or rejected;
- unsupported stage and trailing fields are rejected;
- attempt and timestamp remain server-side;
- capability from sandbox A cannot mutate sandbox B;
- no event accepts a command, SQL, filesystem path, or arbitrary verdict;
- bridge failure does not trigger unsandboxed fallback;
- untrusted worktree content cannot redefine the trusted host receiver.

### Product tests

- session-start marks the ticket active;
- idle/permission notification marks “needs you”;
- user prompt returns it to active;
- session-end clears liveness;
- phase events append evidence;
- explicit impl marker advances exactly as the current CLI path does.

### Exit criteria

- event latency is acceptable for sidebar/dashboard status;
- bridge survives window reload or fails with clear recovery;
- marker security is no weaker than the current separate CLI parse paths;
- autonomous mode remains disabled if bridge preflight fails.

## Increment 4 — ports, services, and gates

### Goal

Run scoped repository commands and services inside the sandbox and expose only
Karst-allocated ports.

### Work

- map declared service ports through `sbx ports`;
- record and reconcile host/sandbox mappings;
- run Docker-backed ticket gates inside the same sandbox;
- preserve async gate execution;
- adapt health checks to published endpoints;
- handle conflicts and sandbox restart;
- decide how baseline services interact with sandbox-backed hot services.

### Tests

- one declared port publishes to the allocated host port;
- undeclared ports are not published;
- conflict causes deterministic reallocation or explicit failure;
- restart restores/verifies mapping;
- server row is written only after successful publication/health;
- long-running gate leaves the extension event loop responsive;
- two repository entries sharing a repoPath still retain distinct service port
  identities.

### Exit criteria

- representative Node service starts and health-checks;
- test/build gates run in sandbox;
- cleanup removes mappings without affecting other tickets;
- existing host service flow remains unchanged.

## Increment 5 — archive, recovery, and provider switching

### Goal

Make Docker sandbox state participate safely in the complete ticket lifecycle.

### Work

- reconcile persisted/derived sandbox identity on activation;
- adopt or reattach after window reload;
- stop versus remove policy;
- remove sandbox during approved archive cleanup;
- provider-switch behavior for incompatible session IDs;
- orphan detection and user-confirmed cleanup;
- settings sweep for stale sandbox hook artifacts.

### Tests

- restored terminal and named sandbox do not create duplicates;
- missing sandbox falls back to a fresh provider session, not another ticket;
- stopped sandbox can restart;
- removed sandbox clears only its association;
- archive removes exact sandbox and preserves worktree archive behavior;
- provider change never sends a foreign session ID;
- multi-window projects cannot control each other's sandboxes.

## Increment 6 — guarded product rollout

### Goal

Expose Docker Sandboxes as a supported opt-in backend.

### UX

- onboarding/settings backend selector;
- dependency/authentication status;
- “Autonomous inside Docker Sandbox” explanation;
- workspace mode and network-profile display;
- reconnect/stop/remove actions where useful;
- disk/resource warning and cleanup controls;
- clear prompted-host fallback chosen explicitly by the user.

### Rollout

1. hidden experimental setting;
2. developer dogfood on Claude and Codex;
3. opt-in settings UI;
4. collect structured failures by capability category;
5. enable per-ticket override;
6. consider default only after platform coverage and recovery are proven.

### Documentation

- update `docs/guides/adding-agent-core.md` with runner interaction;
- document Docker Sandbox prerequisites and OAuth;
- document direct-mode trust boundary;
- document port/network troubleshooting;
- document removal and disk cleanup.

## Future increments

### Clone-mode high isolation

- private clone per ticket;
- fetch/import workflow;
- branch and dirty-state policy;
- diff review before host execution;
- archive and recovery semantics.

### Remote `SessionRunner`

Use the same runner seam for E2B or Daytona:

- remote workspace synchronization;
- SDK-backed PTY;
- API-key and billing model;
- laptop-independent headless stages;
- result/commit import.

Do not force remote-specific concepts into `AgentAdapter`.

## Verification matrix

| Area | Unit | Integration | Manual |
|---|---:|---:|---:|
| Name/policy compilation | Required | — | — |
| `sbx` argv and errors | Required | Fake CLI | — |
| Interactive terminal | Fakes | Real `sbx` opt-in | F5 |
| Provider subscription auth | — | Real `sbx` opt-in | Required |
| Resume/reconnect | Unit state | Real `sbx` opt-in | Required |
| Filesystem isolation | — | Real boundary | Spot-check |
| Credentials/network | — | Real boundary | Spot-check |
| Hook/evidence security | Required | Bridge integration | F5 |
| Ports/services | Required | Real sandbox service | F5 |
| Archive/recovery | Required | Lifecycle integration | F5 |

## Handoff checklist

Before implementation:

- [ ] Read the research and design companions.
- [ ] Confirm current `sbx` docs/version because the product is evolving.
- [ ] Inspect current `SessionManager`, adapters, terminal host, hook endpoint,
      port allocator, archive path, and recovery path.
- [ ] Run the spike; do not skip directly to production refactoring.
- [ ] Record a bridge decision with evidence.

For every increment:

- [ ] Follow RED -> GREEN TDD.
- [ ] Keep `vscode` outside testable core modules.
- [ ] Use async child processes.
- [ ] Preserve separate secure CLI parse paths.
- [ ] Preserve exact owned-path cleanup.
- [ ] Run relevant focused tests.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Request code and security review.

Before rollout:

- [ ] Prove subscription OAuth for Claude and Codex.
- [ ] Prove no host/global-storage access.
- [ ] Prove no host Docker access.
- [ ] Prove bridge authentication and replay behavior.
- [ ] Prove window-reload recovery.
- [ ] Prove archive cleanup.
- [ ] Document explicit fallback behavior.

## Open questions for the spike

1. Which supported Docker Sandbox transport best carries low-latency hooks to
   the extension without opening host localhost?
2. Does direct mode expose the linked worktree's shared Git metadata, and what
   exact mutations need extra protection?
3. How does Docker's Claude OAuth flow persist and proxy subscription tokens in
   the versions Karst will support?
4. Can `sbx run` accept every provider argument Karst currently emits without
   the template replacing or reordering defaults?
5. What is the correct stop policy on terminal close: keep running, stop after
   idle timeout, or user-configurable?
6. How should Karst account for VM disk usage and orphaned sandboxes?
7. Which operating systems and architectures should the first supported release
   promise?
8. Should headless stages share the interactive ticket sandbox or use a fresh
   sandbox with the same worktree?

