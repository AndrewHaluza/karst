# Agent sandbox platform research

Ticket: `869eanxvh`

Status: research complete; Docker Sandboxes selected for an integration spike.

Companion documents:

- [Docker Sandbox agent-session decision](2026-07-28-docker-sandbox-agent-sessions-design.md)
- [Incremental integration plan](../plans/2026-07-28-docker-sandbox-agent-sessions.md)
- [Original sandboxing research](2026-07-28-agent-session-sandbox-research.md)

## 1. Question

Karst launches interactive and headless Claude Code, Codex, and Antigravity
sessions in ticket worktrees. The goal is to let those agents operate with few
or no approval prompts without exposing the rest of the developer machine,
other projects, credentials, Karst's global registry, or the host Docker
daemon.

The chosen environment must preserve Karst's current product experience:

- the user types directly into a VS Code terminal;
- live agent output remains visible;
- follow-up prompts and interrupts work;
- closing and reopening a ticket can continue the session;
- approach artifacts, model selection, and lifecycle hooks still work;
- worktree edits remain visible to VS Code;
- development servers can be reached from the host;
- subscription-backed Claude and Codex authentication remains viable.

## 2. Current Karst execution model

`src/agent/adapter.ts` is the provider boundary. Each `AgentAdapter` builds
provider-specific commands and runs headless stages. `SessionManager` owns the
VS Code terminal and ticket-session lifecycle. Ticket worktrees provide source
separation, but agent processes currently execute on the host.

Important constraints:

- provider-specific flags must remain inside `AgentAdapter`;
- `vscode` must not enter testable core logic;
- the extension host must never block;
- the global SQLite registry must not become writable from an agent sandbox;
- stage and phase evidence must go through narrow, validated verbs;
- generated adapter artifacts must be tracked and cleaned by exact owned paths.

## 3. Evaluated platforms

### 3.1 Provider-native sandboxes

Claude Code and Codex both provide local OS-enforced sandboxing.

Claude Code supports filesystem and network rules, protected credential
locations, fail-closed initialization, and disabling unsandboxed fallback. Its
OS sandbox applies to Bash and child processes; permission rules remain
necessary for in-process tools.

Codex `workspace-write` restricts writes to the active workspace and disables
network access by default. Its current documented controls do not establish
the same explicit credential-read and host-socket denial policy required for
Karst's autonomous mode.

Sources:

- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Codex agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)

Verdict: useful lightweight prompted backend and defense in depth, but not the
preferred common autonomous boundary.

### 3.2 Docker Sandboxes

Docker Sandboxes (`sbx`) is purpose-built for autonomous coding agents. It
supports Claude Code and Codex directly and runs each agent in a microVM with:

- a separate Linux kernel;
- a private filesystem and persistent VM state;
- a private Docker daemon;
- deny-by-default proxied networking;
- host-side credential injection;
- direct workspace mounting or private clone mode;
- named sandbox reconnection;
- interactive terminal attachment;
- SSH integration for VS Code and Cursor;
- explicit port publishing.

Docker's Codex template intentionally runs
`--dangerously-bypass-approvals-and-sandbox` because the microVM, rather than
Codex's inner sandbox, supplies the host boundary.

Sources:

- [Docker Sandboxes overview](https://docs.docker.com/ai/sandboxes/)
- [Architecture and lifecycle](https://docs.docker.com/ai/sandboxes/architecture/)
- [Security model](https://docs.docker.com/ai/sandboxes/security/)
- [Usage and reconnection](https://docs.docker.com/ai/sandboxes/usage/)
- [Supported agents](https://docs.docker.com/ai/sandboxes/agents/)
- [Codex template and authentication](https://docs.docker.com/ai/sandboxes/agents/codex/)
- [Credential isolation](https://docs.docker.com/ai/sandboxes/security/credentials/)
- [Editor integration](https://docs.docker.com/ai/sandboxes/integrations/)

Verdict: best match for local, interactive, subscription-backed Karst sessions.

### 3.3 E2B

E2B provides remote Linux VMs, templates, command execution, filesystem APIs,
and a bidirectional PTY with resize and reconnect support. It is technically
capable of hosting an interactive Karst agent session.

Compared with Docker Sandboxes, Karst would need to add:

- worktree upload, remote clone, or bidirectional synchronization;
- PTY-to-VS Code terminal transport;
- remote sandbox lifecycle and reconnect handling;
- result/commit import into the local worktree;
- a remote-to-local lifecycle and evidence path;
- separate E2B infrastructure billing.

E2B's documented Claude Code flow injects `ANTHROPIC_API_KEY`, which implies
metered API usage. Subscription OAuth inside a persistent E2B VM may be
technically possible, but it is not a documented credential-brokered path and
must not be assumed.

Sources:

- [E2B documentation](https://www.e2b.dev/docs)
- [E2B interactive PTY](https://e2b.dev/docs/sandbox/pty)
- [E2B Claude Code example](https://e2b.dev/docs/agents/claude-code)

Verdict: strong future backend for remote/headless stages and agent fleets, but
not the lowest-risk first backend for Karst's local interactive product.

### 3.4 Daytona

Daytona provides programmable container and VM sandboxes with dedicated
filesystem/network resources, process execution, resource sizing,
pause/resume, snapshots, forks, and persistent storage.

It is a credible remote execution backend. Like E2B, it changes Karst from a
local terminal launcher into a remote workspace and terminal client, so source
synchronization, subscription authentication, and callback routing require
additional design.

Source:

- [Daytona Sandboxes](https://www.daytona.io/docs/en/sandboxes/)

Verdict: retain as a future remote/team backend candidate.

### 3.5 Modal Sandboxes

Modal offers programmable cloud sandboxes, PTYs, secrets, network controls,
volumes, tunnels, resource limits, and filesystem snapshots. A normal sandbox
has a bounded lifetime of up to 24 hours; longer-lived state is restored from
snapshots.

Source:

- [Modal Sandboxes](https://modal.com/docs/guide/sandboxes)

Verdict: suitable for bounded headless stages, less natural for persistent
interactive ticket sessions.

### 3.6 Generic OCI containers and Dev Containers

A hardened container can isolate the filesystem, capabilities, and network, but
Karst would own image construction, credential handling, private Docker
support, cross-platform runtime behavior, persistence, PTY attachment, and
policy management. Dev Containers operate at the whole-window development
environment level rather than as a per-ticket session primitive.

Sources:

- [Docker seccomp](https://docs.docker.com/engine/security/seccomp/)
- [Docker run security options](https://docs.docker.com/reference/cli/docker/container/run/)
- [VS Code Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers)

Verdict: do not build a generic container runner before proving that Docker
Sandboxes cannot satisfy the product.

## 4. Comparison

| Criterion | Docker Sandboxes | E2B | Daytona | Provider native |
|---|---|---|---|---|
| Local ticket worktree | Direct mount or clone | Sync required | Sync required | Native |
| Interactive terminal | Built in | PTY API | Process/terminal APIs | Native |
| Reattach/persistence | Named persistent VM | Supported | Supported | Provider-specific |
| Subscription OAuth | Documented broker/login | Not established | Not established | Native |
| Credential isolation | Host proxy | Injected secrets | Injected secrets | Provider-specific |
| Private Docker daemon | Yes | Template-dependent | Template-dependent | No |
| Network policy | Host proxy | Cloud policy | Cloud policy | Provider-specific |
| Additional compute billing | No hosted compute | Yes | Yes | No |
| Laptop can be offline/closed | No | Yes | Yes | No |
| Karst integration effort | Medium | High | High | Low |
| Best use | Local interactive autonomy | Remote/headless fleet | Remote/team fleet | Prompted local work |

## 5. Subscription-backed usage

Sandboxing does not itself select subscription or API billing. Authentication
does:

```text
provider OAuth login -> Claude Pro/Max or ChatGPT subscription limits
provider API key     -> metered API billing
```

Docker Sandboxes supports host-side OAuth for Codex and an OAuth-capable Claude
Code flow. The credential proxy keeps raw provider credentials outside the VM.
Therefore the existing subscription-based product idea can survive the Docker
Sandbox layer.

For E2B, Daytona, and Modal, the safe planning assumption is API billing until
a provider-supported OAuth proof demonstrates otherwise.

## 6. Docker-specific gaps Karst must solve

Docker supplies isolation, terminal attachment, persistence, credentials, and
network governance. It does not know Karst's workflow.

The integration still needs:

1. stable mapping from ticket to sandbox name;
2. mapping from ticket to provider session/resume ID;
3. safe lifecycle-hook transport back to the extension;
4. authenticated stage/phase evidence without DB access;
5. integration with Karst's port allocator;
6. exact cleanup when tickets are archived;
7. policy for direct workspace mode versus clone mode;
8. disabling the default cross-sandbox shared skills store;
9. dependency and capability diagnostics when `sbx` is unavailable.

The lifecycle bridge is the feasibility gate. Docker blocks sandbox access to
host localhost, private IP ranges, raw TCP, UDP, and ICMP. The spike must prove
a supported, authenticated route rather than weakening that boundary.

## 7. Research conclusion

Use Docker Sandboxes as Karst's preferred experimental autonomous backend.
Keep host/provider-native execution as a supported prompted backend. Reserve a
future `SessionRunner` seam for E2B, Daytona, or another remote backend, but do
not build those integrations before the local Docker spike succeeds.

