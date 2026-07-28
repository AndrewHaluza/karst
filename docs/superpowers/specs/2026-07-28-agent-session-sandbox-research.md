# Agent session sandboxing research

Ticket: `869eanxvh`

> **Superseded recommendation:** Follow-up research selected Docker Sandboxes
> as the preferred experimental autonomous backend. This document is retained
> for its threat model and provider-native analysis. See
> [Agent sandbox platform research](2026-07-28-agent-sandbox-platform-research.md),
> [Docker Sandbox agent-session decision](2026-07-28-docker-sandbox-agent-sessions-design.md),
> and the
> [incremental integration plan](../plans/2026-07-28-docker-sandbox-agent-sessions.md).

## Outcome

Karst should use a **two-tier isolation model**:

1. Make each provider's native sandbox the default execution boundary now.
2. Add an optional OCI/VM-backed session runner later for tickets that need a
   stronger host boundary or intentionally run with provider approval prompts
   disabled.

The first increment should support Claude Code and Codex without making the
session manager or workflow stages provider-aware. The `AgentAdapter` remains
the owner of provider-specific policy, while the session manager and headless
spawner must take responsibility for constructing the child environment. Karst
supplies a provider-neutral `IsolationPolicy` when it launches a session.

Do **not** equate `--dangerously-skip-permissions` with safety. Approval bypass
only becomes acceptable when:

- the sandbox is fail-closed;
- writes are limited to the ticket worktree and session temp directory;
- host credentials and environment secrets are unavailable;
- network access is denied or explicitly allowlisted;
- no Docker socket, host agent socket, or broad host directory is exposed; and
- stage/phase evidence still crosses the boundary through a narrow broker,
  rather than by making the global Karst database writable.

## 1. Current Karst boundary

Karst is already close to the right architecture:

- `src/agent/adapter.ts` is the single provider boundary for interactive and
  headless execution.
- `src/agent/claude.ts` owns Claude CLI flags and generated `--settings`.
- `src/agent/codex.ts` owns Codex approval and sandbox flags.
- `SessionManager` launches an `InteractiveCommand` and does not need to know
  provider syntax.
- ticket worktrees already give each session a distinct writable source tree.
- generated hook configuration is stored outside the repository in a shared
  extension settings directory, using per-window/per-launch filenames;
- approach materialization receives the worktree as `sessionDir`: Claude writes
  `<worktree>/.karst-plugin/...`, while Codex writes
  `<worktree>/.agents/skills/...`. Both are agent-writable, adapter-owned
  worktree content rather than immutable policy input.

Codex currently maps Karst's `bypassPermissions` mode to
`--ask-for-approval never --sandbox workspace-write`. That is substantially
safer than `--dangerously-bypass-approvals-and-sandbox`, but it is not a
complete Karst policy: the effective writable roots, readable host paths,
network policy, inherited environment, and out-of-worktree evidence channel
must also be controlled and tested.

Claude currently receives hook settings, but Karst does not generate a
fail-closed sandbox policy. Claude's native sandbox can enforce filesystem and
network restrictions for Bash and child processes. Anthropic explicitly notes
that permission rules and the OS sandbox are separate layers, and that the
sandbox applies only to Bash and its children. Consequently, native Claude
sandboxing must be paired with deny rules for non-Bash tools such as Read,
Edit, WebFetch, and MCP.

## 2. Threat model

### Protect

- files outside the ticket worktree, especially other repositories/worktrees;
- SSH, cloud, package-registry, GitHub, and agent credentials;
- the Karst global SQLite registry and other projects' ticket state;
- the host Docker daemon, desktop applications, Unix sockets, and extension
  host;
- the network from arbitrary egress and the host from untrusted downloaded
  code.

### Assume hostile

- ticket text, repository files, dependencies, test fixtures, and fetched
  approach packages may contain prompt injection;
- the agent may execute a repository script whose behavior is not visible in
  the command line;
- a subprocess may try path traversal, symlink tricks, socket access, or
  credential discovery;
- a malicious repository may modify files later interpreted by a trusted host
  component.

### Out of scope for the first increment

- protection from kernel or hypervisor vulnerabilities;
- safe use of arbitrary hardware devices;
- multi-tenant hostile workloads;
- making an exposed Docker socket safe (it is effectively host control);
- silently permitting writes to the global Karst registry.

## 3. Options

| Option | Isolation | Cross-platform | UX/startup | Karst effort | Verdict |
|---|---|---:|---:|---:|---|
| Provider-native sandbox | Process/OS policy | Best | Native/fast | Small | **Default now** |
| Hardened OCI container | Linux namespaces, capabilities, seccomp | Docker/Podman-dependent | Image/tool setup | Medium-high | **Optional tier next** |
| VS Code Dev Container | Whole extension workspace in container | Good with VS Code support | Window reload; project-owned config | High/invasive | Support, do not orchestrate |
| Per-container lightweight VM | Separate kernel | Platform-dependent | Heavier | High | Future high-assurance tier |
| macOS `sandbox-exec` wrapper | Seatbelt profile | macOS only; deprecated interface risk | Fast | Medium | Do not build directly |
| Firecracker/gVisor/Kata | VM or userspace-kernel boundary | Primarily Linux | Operationally heavy | Very high | Server/team deployment only |

### A. Provider-native sandbox

This is the best first move because it preserves native authentication, TTY,
resume behavior, hooks, model discovery, and approach materialization.

Claude Code's sandbox uses Seatbelt on macOS and bubblewrap on Linux/WSL2. It
can fail closed (`failIfUnavailable`), prohibit unsandboxed fallback
(`allowUnsandboxedCommands: false`), constrain filesystem access, protect
credential files/environment variables, and restrict network domains. Its
default read policy remains broad, so Karst must explicitly deny the home
directory and re-allow only the worktree and required read-only toolchain paths.
[Anthropic sandbox documentation](https://code.claude.com/docs/en/sandboxing)

Codex exposes approval and sandbox modes. `workspace-write` limits writes to the
active workspace and disables network access by default, but the documented
CLI controls do not provide a Karst-defined equivalent of Claude's credential
read-deny policy. Karst should keep using documented approval/sandbox controls
and must never emit the combined dangerous bypass flag. Until an outer boundary
or tested provider controls close the read/credential/socket gaps, Codex native
mode remains **prompted-only**, not eligible for Karst's autonomous toggle.
[OpenAI agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security)

Limits:

- policy semantics differ by provider;
- provider sandboxes are not identical security boundaries;
- Claude non-Bash tools require explicit permission denies;
- an agent upgrade can change flags or behavior, so Karst needs capability
  probes and integration tests, not only command-array unit tests.

### B. Hardened OCI container

Run the provider CLI inside an ephemeral container with:

- a non-root user and read-only root filesystem;
- only the ticket worktree mounted read-write;
- session configuration mounted read-only where possible;
- a fresh tmpfs for `/tmp`;
- all Linux capabilities dropped;
- `no-new-privileges`;
- Docker's default seccomp profile;
- no host/PID/device namespace sharing;
- no Docker/Podman socket;
- network disabled by default, or routed through an allowlisting proxy;
- explicit CPU, memory, PID, and disk limits;
- a minimal, pinned image containing the provider CLI and project toolchain.

Docker documents that its default seccomp profile blocks a set of sensitive
syscalls and recommends keeping it enabled. It also warns that `--privileged`
disables major confinement mechanisms and is not a secure sandbox.
[Docker seccomp](https://docs.docker.com/engine/security/seccomp/),
[Docker run security options](https://docs.docker.com/reference/cli/docker/container/run/)

This is defense in depth, not a reason to disable the provider's inner sandbox.
The inner sandbox may need a documented nested mode; Claude warns that its
weaker nested mode should only be used when the outer container supplies the
needed boundary.

Main integration costs:

- authentication must be brokered or mounted without exposing reusable host
  credential stores;
- the CLI binary and repo toolchain must exist in the image;
- interactive PTY, resize, signals, hooks, and resume storage must survive;
- macOS bind mounts are slower, and UID/GID mapping differs by runtime;
- arbitrary project services may need deliberate port and network policy.

### C. VS Code Dev Containers

Dev Containers run most workspace extensions and tools inside the container
and can use an isolated volume instead of a host bind mount. This is a good
user-managed deployment mode, but a poor per-ticket primitive: reopening the
window changes where the Karst extension host runs, and repository-controlled
`devcontainer.json` is itself untrusted input.
[VS Code Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers)

Karst should detect and work correctly when already running in a Dev Container,
but should not make the extension orchestrate window reloads for each ticket.

### D. Lightweight VM per session

A separate kernel materially improves isolation from the host. Apple's
`container` runs each Linux container in its own lightweight VM, but currently
requires Apple silicon and macOS 26 and is still pre-1.0. It is promising as an
optional backend, not a portable default.
[Apple container](https://github.com/apple/container),
[Apple Containerization](https://github.com/apple/containerization)

The same `SessionRunner` abstraction proposed below could later target a remote
VM, Apple `container`, Kata, or a managed sandbox service without changing
agent adapters.

## 4. Recommended architecture

Keep policy, provider translation, and process isolation as three separate
concerns:

```text
SessionManager
  └─ IsolationPolicy (provider-neutral intent)
       └─ AgentAdapter (Claude/Codex flags + settings)
            └─ SessionRunner (host process | OCI | future VM)
                 └─ PTY/process
```

Suggested types:

```ts
type IsolationMode = 'provider' | 'container';

interface IsolationPolicy {
  mode: IsolationMode;
  approvals: 'prompt' | 'never';
  filesystem: {
    writable: string[];
    readable: string[];
    denied: string[];
  };
  network: { mode: 'deny' | 'allowlist'; hosts: string[] };
  inheritEnvironment: string[];
}

interface SessionRunner {
  checkAvailability(): Promise<Availability>;
  launch(command: InteractiveCommand, policy: IsolationPolicy): Promise<void>;
  runHeadless(command: HeadlessCommand, policy: IsolationPolicy): Promise<Result>;
}
```

`IsolationPolicy` must express intent, not Claude/Codex/Docker flags.
`AgentAdapter` translates the provider-enforceable subset and fails if a
required guarantee is unsupported. `SessionRunner` enforces the outer
process/container boundary. A policy compiler should return an explanation of
the effective policy for UI and diagnostics.

The policy must also identify which guarantees are required for a launch and
which are merely reported capabilities. A provider cannot claim support by
silently ignoring a field.

| Guarantee | Claude native | Codex native | Hardened OCI |
|---|---:|---:|---:|
| Worktree-only writes | Yes, with generated settings | Yes, `workspace-write` | Yes |
| Network denied | Yes | Yes by default | Yes |
| Network hostname allowlist | Yes | Yes, with network proxy configuration | Yes, through proxy |
| Explicit home/credential read denial | Yes | Not established by current controls | Yes |
| Unsandboxed fallback disabled/fail-closed | Yes | Capability probe required | Yes |
| Host socket/device denial | Partial/provider-dependent | Not established by current controls | Yes |
| Autonomous eligibility | After boundary tests | **No; prompted-only** | After boundary tests |

### Evidence and hook channel

Never mount the global Karst storage directory read-write. That would let
prompt-injected code bypass the narrow CLI parsers and mutate any project.

Instead:

- keep lifecycle hooks as loopback HTTP with an unguessable per-launch token;
- add narrowly typed `phase` and `stage` endpoints, or retain exact-command
  approval for the current CLI marker;
- validate ticket, project, stage, launch generation, and one-time/replay
  semantics outside the sandbox;
- do not accept arbitrary SQL, paths, commands, verdicts, attempts, or
  timestamps from the agent;
- for a container runner, expose only the broker address, not the DB file.

On macOS/Windows containers, reaching the host loopback needs a runtime-specific
mapping. Treat that mapping as `SessionRunner` plumbing, not adapter behavior.

### Credentials

The provider needs its own authentication, but repository subprocesses should
not automatically inherit every host secret.

- construct an allowlist environment at the process runner boundary instead of
  copying `process.env`;
- scrub `SSH_AUTH_SOCK`, cloud tokens, package tokens, and unrelated API keys;
- prefer provider login brokers or short-lived tokens;
- allow opt-in secret injection by hostname and command, never broad home-dir
  mounts;
- redact the effective environment from logs and diagnostics.

### Network

Default to deny. Define named profiles such as:

- `offline`: no egress;
- `dependencies`: package registries selected by the project;
- `vcs`: GitHub/GitLab endpoints needed by an explicit workflow;
- `custom`: user-maintained hostname allowlist.

Hostname allowlists do not inspect encrypted content and broad hosts can still
be exfiltration channels. High-assurance mode needs an outbound proxy with
logging, TLS-aware policy where appropriate, and no direct route around it.

## 5. Safe meaning of “skip permissions”

Karst may offer an autonomous toggle only when the effective policy passes a
preflight:

| Requirement | Provider tier | Container tier |
|---|---:|---:|
| Sandbox available and fail-closed | Required | Required |
| Worktree is the only project write root | Required | Required |
| Home/credentials denied | Required | Required |
| Network denied or allowlisted | Required | Required |
| Unsandboxed fallback disabled | Required | Required |
| No powerful host sockets/devices | Best effort | Required |
| Resource limits | Provider-dependent | Required |
| Narrow Karst evidence broker | Required | Required |

If any required check fails, Karst must downgrade to prompted approvals or
refuse launch. It must not silently fall back to unsandboxed execution.

This table describes the target autonomous policy. It does not imply that every
provider-native backend currently satisfies it: the capability matrix above
explicitly keeps Codex native mode prompted-only.

The UI should say **Autonomous inside sandbox**, not “dangerously skip
permissions”. Show the effective write roots, network profile, credential
policy, and isolation backend before launch.

## 6. Delivery plan

### Phase 0 — close the existing bypass path

Before advertising any autonomous mode, reject or downgrade the current
`bypassPermissions` request in every adapter, including Antigravity, unless the
effective backend passes all required capability checks and an authenticated,
ticket/project/verb-bound evidence path is available. Existing Codex
`--ask-for-approval never --sandbox workspace-write` behavior is not sufficient
by itself.

### Phase 1 — provider-native policy and process environment

1. Add `IsolationPolicy` and a policy compiler, defaulting to provider sandbox,
   prompted approvals, worktree-only writes, denied credentials, and denied
   network.
2. Extend `InteractiveCommandOpts` and `RunHeadlessOpts` with the neutral policy.
3. Change `SessionManager` and all headless spawners to launch from an explicit
   environment allowlist. VS Code terminal `env` entries only add to or override
   the inherited environment; they do not remove unspecified host variables, so
   the host/runner must explicitly unset denied names.
4. In `ClaudeAdapter`, merge a Karst-authored sandbox and permission policy into
   the existing generated settings:
   - `enabled: true`;
   - `failIfUnavailable: true`;
   - `allowUnsandboxedCommands: false`;
   - deny home/credential reads and allow only required worktree paths;
   - strict network allowlist;
   - deny non-Bash tools that bypass the Bash sandbox unless explicitly needed.
5. In `CodexAdapter`, compile to documented approval and sandbox options. Keep
   the dangerous combined bypass flag forbidden and native execution
   prompted-only until read/credential/socket controls are proven.
6. Treat every provider's generated worktree content—currently Claude
   `.karst-plugin` directories and Codex `.agents/skills`—as disposable
   adapter-owned paths. Record and clean only the exact returned paths, and
   ensure their mutable content is not authority consumed by a trusted host
   process.
7. Add a launch preflight and an “effective isolation” diagnostic.
8. Test both command construction and real boundary behavior with probes that
   attempt outside writes, secret reads, and network egress.

### Phase 2 — narrow evidence broker

1. Authenticate hook/marker requests with per-launch capabilities.
2. Bind each capability to one ticket, project, and allowed verb.
3. Add replay protection and audit records.
4. Remove any need for an agent-writable DB path.

### Phase 3 — experimental OCI runner

1. Introduce `SessionRunner`; preserve the current host runner.
2. Add an opt-in rootless Docker or Podman runner.
3. Start with headless stages, which avoid interactive PTY/resume complexity.
4. Add interactive sessions after terminal resize, signals, hooks, auth, and
   cleanup are proven.
5. Keep provider-native sandboxing enabled inside the container.

### Phase 4 — stronger/remote backends

Evaluate Apple `container`, a remote sandbox service, or VM-backed runtimes
through the same runner contract. Select by capability probe, not operating
system name alone.

## 7. Acceptance tests

Tests must prove enforcement, not merely assert emitted flags:

- writing inside the ticket worktree succeeds;
- reading/writing a sibling worktree fails;
- reading representative SSH/cloud credentials fails;
- an unlisted network destination fails;
- an allowlisted dependency host works only in the matching profile;
- child and grandchild processes remain confined;
- symlink and `../` escapes fail;
- access to Docker/Podman/SSH agent sockets fails;
- sandbox initialization failure prevents autonomous launch;
- provider resume and lifecycle hooks still work;
- the exact ticket can report allowed evidence, but cannot forge another stage,
  ticket, project, attempt, or timestamp;
- closing or crashing a session removes only Karst-owned runtime artifacts;
- container resource exhaustion is bounded and cleanup is idempotent.

Run these as opt-in integration suites on macOS and Linux. Unit tests for
command arrays remain useful, but are not security evidence.

## 8. Decision

Implement provider-native, fail-closed policies first. This is a small,
architecture-aligned improvement that covers the common local workflow and
allows autonomous execution within explicit bounds.

Build the narrow evidence broker before enabling any autonomous mode and before
an OCI runner. Without the broker, containerization either breaks stage
tracking or tempts Karst to mount its global registry into the sandbox, undoing
the isolation.

Treat an OCI/VM runner as an additional assurance tier, not as a replacement
for provider sandboxing. Start it with headless stages, keep it opt-in until
cross-platform auth/toolchain ergonomics are proven, and never enable
`--privileged`, mount a container daemon socket, or silently relax policy.
