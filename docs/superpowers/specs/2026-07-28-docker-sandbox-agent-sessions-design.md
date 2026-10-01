# Docker Sandbox agent sessions

Ticket: `869eanxvh`

Status: proposed architecture; implementation gated by feasibility spike.

Research:
[Agent sandbox platform research](2026-07-28-agent-sandbox-platform-research.md)

Implementation:
[Incremental integration plan](../plans/2026-07-28-docker-sandbox-agent-sessions.md)

## 1. Decision

Add Docker Sandboxes as an optional execution backend for Karst agent sessions.
Preserve host execution as the default until the integration passes real
boundary, lifecycle, resume, and compatibility tests.

Karst will not implement its own container or microVM runtime. It will delegate
isolation, agent credential brokering, VM persistence, private Docker, and
network governance to `sbx`.

## 2. Product contract

Docker-backed sessions must preserve the existing interaction model:

1. The user opens a ticket session from Karst.
2. A normal VS Code terminal appears.
3. Claude Code or Codex renders its native interactive UI.
4. The user types prompts, sends follow-ups, answers questions, and interrupts
   commands normally.
5. File edits appear in the ticket worktree and VS Code Source Control.
6. Reopening focuses the live terminal when it exists.
7. If the terminal is gone, Karst reattaches to the named sandbox.
8. If the provider process ended, Karst launches it with the recorded provider
   resume ID.
9. Archiving the ticket removes the sandbox and only Karst-owned runtime
   artifacts.

Docker persistence and provider resume solve different problems:

- Docker preserves the computer, installed packages, images, and agent files.
- Claude/Codex resume preserves the conversation.
- Karst binds both identities to the ticket.

## 3. Architecture

```text
Ticket action
    |
    v
SessionManager
    |
    +-- resolve AgentAdapter(ticket provider)
    |       |
    |       +-- provider command, model, resume, approach
    |
    +-- resolve SessionRunner(ticket execution backend)
            |
            +-- HostSessionRunner
            |       `-- current VS Code terminal behavior
            |
            `-- DockerSandboxRunner
                    `-- sbx run/create/stop/rm/ports
                            |
                            `-- Claude/Codex inside microVM
```

Provider knowledge stays in `AgentAdapter`. Execution-location knowledge stays
in `SessionRunner`. `SessionManager` coordinates the two without branching on
Claude/Codex syntax or Docker details.

## 4. Proposed contracts

Names are illustrative; the implementation plan begins with tests and may
refine them.

```ts
export type ExecutionBackend = 'host' | 'docker-sandbox';

export interface SessionIdentity {
  ticketId: number;
  worktreePath: string;
  provider: AgentProvider;
  providerSessionId?: string;
}

export interface SessionLaunch {
  identity: SessionIdentity;
  command: InteractiveCommand;
  ownedPaths: string[];
}

export interface SessionRunner {
  readonly backend: ExecutionBackend;
  checkAvailability(): Promise<RunnerAvailability>;
  buildTerminalCommand(launch: SessionLaunch): Promise<InteractiveCommand>;
  stop(identity: SessionIdentity): Promise<void>;
  remove(identity: SessionIdentity): Promise<void>;
  publishPort(identity: SessionIdentity, containerPort: number): Promise<number>;
}
```

The runner returns command data. The existing injected terminal host remains
the component that creates and focuses VS Code terminals.

Headless execution should eventually use the same backend selection, but the
first production increment may limit Docker execution to interactive impl
sessions if that reduces risk.

## 5. Sandbox identity

Use a deterministic, bounded, shell-safe name derived from stable database
identity, not ticket title:

```text
karst-<project-id>-<ticket-id>
```

The exact formatter must:

- use Docker-supported characters;
- be stable across window reloads;
- distinguish equal ticket keys in different projects;
- avoid leaking ticket content;
- reject or truncate safely if Docker imposes a length limit.

Persist the backend and sandbox name if reconciliation cannot derive them
without ambiguity. Any schema change must follow the repository migration
checklist.

## 6. Workspace mode

### Initial mode: direct ticket-worktree mount

Use Docker's direct workspace mode for the first integration:

- edits appear immediately in VS Code;
- current diffs and Source Control continue to work;
- no source synchronization layer is needed;
- Karst's per-ticket worktree already bounds intended writes.

The microVM protects the rest of the host, but the worktree remains a shared
trust boundary. A compromised agent can change files later executed by the
trusted host, including:

- Git hooks and configuration reachable from the worktree;
- `.vscode/tasks.json`;
- package-manager scripts;
- CI workflows;
- Claude/Codex project configuration;
- generated approach commands.

All repository commands for Docker-backed tickets should run inside the same
sandbox wherever practical. Before a host-side action consumes mutable
worktree configuration, Karst must either validate it or require explicit user
approval.

### Future mode: clone

Docker `--clone` makes the host repository read-only and keeps agent changes in
a private clone. It is a stronger boundary but requires commit/diff import,
branch reconciliation, dirty-tree rules, and different archive semantics.
Defer it until direct mode is stable.

## 7. Agent and approach behavior

`AgentAdapter` continues to:

- choose Claude/Codex executable syntax;
- resolve model and provider resume ID;
- create hook configuration;
- materialize neutral approach packages;
- return exact owned paths.

Docker Sandbox templates may supply default dangerous-bypass flags. Karst must
test the resulting final command and avoid conflicting provider flags.

Disable Docker's shared skills store for Karst-created sandboxes. Every ticket
must receive only its chosen, sanitized Karst approach artifacts. Cross-ticket
shared writable instructions would violate Karst's isolation model.

## 8. Authentication

Use Docker's supported credential broker:

- Codex: host-side OAuth via `sbx secret set -g openai --oauth`, or an explicitly
  selected API key;
- Claude Code: supported OAuth/login flow for Claude subscription use, or an
  explicitly selected API key.

Karst must not copy `~/.claude`, `~/.codex`, SSH private keys, cloud credential
directories, or general host environment variables into the VM.

Dependency diagnostics should distinguish:

- `sbx` missing;
- Docker Sandbox login missing;
- provider credential missing;
- provider template unavailable;
- sandbox policy incompatible;
- OAuth requiring user interaction.

## 9. Lifecycle and evidence bridge

### Requirements

The bridge must carry:

- session start/end;
- waiting/active signals;
- provider session ID capture;
- user prompt/tool-use lifecycle events;
- phase entry evidence;
- the explicit impl-complete marker.

It must not expose:

- the Karst SQLite file;
- arbitrary host command execution;
- arbitrary ticket, stage, attempt, timestamp, or verdict mutation;
- a reusable credential valid for another ticket.

### Security shape

```text
Agent hook
    |
    | ticket-bound, launch-bound message
    v
Sandbox-side relay
    |
    | authenticated supported sbx boundary transport
    v
Karst hook/evidence receiver
    |
    | validate project + ticket + launch + allowed verb
    v
existing dispatcher / narrow CLI logic / transaction
```

Each launch gets an unguessable capability bound to:

- project ID;
- ticket ID;
- sandbox name;
- launch generation;
- allowed event/verb set;
- expiry.

Replay-sensitive evidence must be one-time or idempotent. Attempt and timestamp
remain server-side.

### Feasibility gate

Docker blocks access from the sandbox to host localhost and private IP ranges.
No production design is approved until the spike proves a supported route that
does not disable this network boundary. Candidate mechanisms must be evaluated,
not assumed:

- Docker Sandbox-supported local-service routing;
- a published, authenticated relay with constrained ingress;
- a host-side `sbx` event or exec channel;
- polling a sandbox-owned append-only event file from the host.

File polling may be acceptable for phase/stage evidence but is likely
insufficient for low-latency “needs you” UI unless paired with change
notification.

## 10. Ports and services

Services run inside the sandbox. Karst remains the allocator of host ports.

Target flow:

```text
manifest service port
    -> Karst allocates host port
    -> DockerSandboxRunner publishes sandbox port
    -> mapping recorded against repository name
    -> health checks use published host endpoint
```

Publishing occurs after sandbox creation because `sbx` does not publish ports
at create time. Reconciliation must restore or verify mappings after restart
and handle host-port conflicts deterministically.

Do not expose arbitrary ports automatically. Only ports declared by the scoped
runnable repositories or explicitly approved by the user may be published.

## 11. Lifecycle mapping

| Karst action | Docker-backed behavior |
|---|---|
| Open fresh | Create named sandbox, materialize approach, attach provider |
| Open live | Focus existing VS Code terminal |
| Reopen without terminal | `sbx run --name <name>` and attach |
| Continue ended provider | Attach sandbox, start provider with resume ID |
| Stop | Close provider/terminal, optionally `sbx stop` |
| Window reload | Reconcile named sandbox and adopt/recreate terminal handle |
| Archive | Stop and remove exact sandbox, then existing worktree archive |
| Provider switch | Refuse incompatible resume; recreate or reconfigure explicitly |

Sandbox removal is destructive to VM-local state. It must occur only for the
exact derived/persisted ticket sandbox and only at the lifecycle point approved
by the user or existing archive workflow.

## 12. Configuration and rollout

Illustrative manifest shape:

```yaml
agentExecution:
  backend: host
  dockerSandbox:
    workspaceMode: direct
    networkProfile: development
```

Rules:

- `host` remains the initial default;
- `docker-sandbox` is opt-in during experimental rollout;
- backend selection may later become a per-ticket override;
- manifest validation and write overlay must be updated together;
- UI copy must describe effective isolation and prerequisites;
- loading old manifests must remain unchanged.

Do not expose a raw “dangerously skip permissions” toggle. Present the outcome
as “Autonomous inside Docker Sandbox” after successful preflight.

## 13. Failure behavior

Karst must fail closed:

- unavailable `sbx` never falls back silently to dangerous host execution;
- failed sandbox creation does not record a live agent;
- failed authentication surfaces an actionable diagnostic;
- failed hook bridge prevents autonomous mode;
- failed port publishing leaves no server row claiming health;
- cleanup removes only the exact ticket sandbox and returned owned paths;
- a stopped sandbox may be restarted; a removed sandbox is treated as a fresh
  environment and provider resume compatibility is re-evaluated.

The user may explicitly choose prompted host execution as a fallback.

## 14. Decision consequences

Benefits:

- strong microVM host boundary without Karst owning a runtime;
- subscription-backed Claude/Codex remains possible;
- existing terminal UX survives;
- private Docker enables agent-run builds and Compose safely;
- persistent environments speed repeated ticket work;
- the future `SessionRunner` seam can support remote backends.

Costs:

- new `sbx` dependency and platform prerequisites;
- VM disk and memory consumption;
- lifecycle/evidence bridge engineering;
- port-publishing integration;
- direct-mode workspace remains a trusted-host handoff risk;
- Docker Sandboxes product/version changes require capability probes.

## 15. Approval criteria

This design becomes implementation-approved only when the spike proves:

- interactive input/output in Karst's VS Code terminal;
- subscription OAuth for one Claude and one Codex session;
- close/reconnect and provider conversation resume;
- real-time or acceptable-latency lifecycle events;
- authenticated stage marker without DB access;
- direct-mode edits visible on the host;
- one published dev-server port;
- host filesystem, host Docker, private IP, and credential isolation;
- deterministic stop/remove/reconcile behavior.

