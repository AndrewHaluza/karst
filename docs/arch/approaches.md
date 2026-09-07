# Approach packages: lifecycle (install → launch → uninstall)

Karst's approach/agent-package system: the invoking agent's workflow is driven by a configured "approach" (a sourced package of prompts/artifacts) plus an agent adapter that translates it to a concrete agent CLI. This file covers the package lifecycle; the adapter seam that consumes it lives in CLAUDE.md's architecture section.

## Approach packages are agent-agnostic; only the AgentAdapter translates to a concrete agent's format

Install (`approaches/fetch.ts`) fetches STRUCTURE-PRESERVING into a neutral typed package: `classifyPath` (`approaches/classify.ts`) maps `.claude/agents`→`agents/`, `.claude/commands`→`commands/`, `skills/<name>`→`skills/<name>/` (a skill IS its folder), all recorded as `ApproachArtifact {kind,relPath}` in `approach.yml` (`approaches/pkg.ts`). Unclassified paths fall back to the legacy flat `prompts/` bucket (basenames). NO "plugin" concept lives in install/manifest. At launch, `AgentAdapter.materializeApproach` (optional) turns the neutral package into agent-specific launch `extraArgs` — `ClaudeAdapter` builds a `.claude-plugin` dir + returns `--plugin-dir` (the ONLY place the plugin format exists). Absent method → bare launch.

## Approach `entrypoint` is a BARE name

No `.md`. It MUST resolve against what was collected — a skill folder name, an agent/command file basename, OR a flat prompt basename — or install fails (`assertEntrypointResolvable`, checks `resolvableNames`). Dangling = loud install failure, never a silent bare launch. `resolveApproachPrompt` (`approaches/resolve.ts`) reads `prompts/<entrypoint>.md` first (flat/back-compat), then — when no flat prompt exists — resolves the bare name against the package's collected artifact inventory and reads the listed `skills/<entrypoint>/SKILL.md`; an entrypoint that resolved to an agent/command basename is never answered with a same-named skill's body, and a package whose inventory lists no skill returns null.

## A sourced install must CONTRIBUTE something

`assertPackageContributes`, in `assembleAndWrite` alongside the entrypoint/workflow guards: reject at install if it collected no prompts AND no artifacts AND declares no `workflow`. Without this a misconfigured approach (e.g. `gsd` with `collect: []`, no `entrypoint`) installs "clean" then only fails at launch via the soft `extension.ts` "produced no method prompt or loadable artifacts" warning — the failure must surface where the manifest is entered. `@opengsd/gsd-core` is a Claude-Code PLUGIN (skills/agents/commands live in the tree), so it belongs on a `git` source that fetches them, NOT an `npm` source whose bin scaffolds nothing into the temp cwd.

## An approach's `enabled` flag is SLAVED to what is on disk, and uninstall owns three things

`enabled: true` with no installed package is the state `setApproachEnabled` already refuses to create ("Install X before enabling it") — but only on the enable path, so install/uninstall drifted the manifest away from disk in both directions. `reconcileApproachEnabled` (`ui/settings/actions.ts`) now points the flag at `listInstalledIds()` after EVERY install or uninstall attempt: it reads disk rather than assuming the attempt's outcome, so a source that can never produce a package (`gsd`'s npm `collect: []`) retires itself on the failure, while a transient fetch error that left the old package intact correctly changes nothing. Uninstall removes the package dir, **every ticket reference** (`clearApproachFromTickets`, project-scoped — the DB is shared by every window) and the flag; deleting the manifest ENTRY stays a separate deliberate act (the drawer's Delete, which requires an uninstall first). Leaving the ticket references was what made the launch warning outlive the uninstall: `toApproachRows` DROPS sourced-but-uninstalled approaches, so the stale value was not even offered as an option the user could change (869eckp0x). A manifest that failed to load is NEVER rewritten — `loadState` falls back to an in-memory copy on a parse error, and overlaying a flag onto that writes the fallback over the user's file.

## `writeApproachArtifacts` REPLACES the package dir; it never overlays

A reinstall must land the source's current contents and nothing else. Overlaying kept every file a previous install fetched and this one did not, and those leftovers are not inert — `materializeApproach` copies a skill's whole FOLDER into the launch plugin, so a stale sibling still reached the agent. The install guards (`assertEntrypointResolvable`/`assertWorkflowCommandsResolvable`/`assertPackageContributes`) all run BEFORE the write, so a rejected install never destroys the working package it would have replaced. `approaches/lifecycle.test.ts` pins the whole install→uninstall→reinstall cycle end to end, including that N cycles converge to the same bytes as one.

## Untrusted-source hardening

`sanitizeFrontmatter` (`approaches/sanitize.ts`) strips dangerous permission frontmatter (`permissionMode: bypassPermissions`, `allowed-tools`, `dangerously-*`) from EVERY fetched body at install (in `assembleAndWrite`) so materialization can't silently grant bypass — karst's own `--settings` stays the sole permission authority.
## An approach body may NEVER block on the user inside a driven stage
An approach body executes as the instructions of a karst-driven stage. The marker contract
(`renderDoneMarkerInstruction`, AGENT_GUIDE rule 3) refuses the done marker while the agent is
waiting on the user — and an agent-advanced stage such as `impl` has no gate that can fail it.
So a body carrying a "stop and wait for user approval" directive deadlocks: the agent correctly
withholds the marker, nothing else moves the stage, and the ticket parks forever.

**The gates are the approval.** A phase-validation step is self-validated against its checklist
and recorded (see `karst-rpi-implement` Step 5); anything genuinely undecidable is recorded as an
open question and left to fail a gate, where the block is visible in karst. Enforced by
`src/agents/skillBlockingDirective.test.ts`, which scans every packaged skill body for
stop-and-wait-for-user directives.
