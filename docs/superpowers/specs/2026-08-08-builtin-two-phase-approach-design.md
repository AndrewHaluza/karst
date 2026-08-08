# Built-In Two-Phase Approach Design

## Summary

Karst will ship a built-in `karst-two-phase` approach that runs Research & Plan and Implement as two separately configured interactive agent sessions. The extension automatically hands the ticket from the first phase to the second, allowing users to spend an expensive model on planning and a cheaper model on execution without manually switching providers.

The approach is available immediately after extension installation, requires no network install, and may be disabled. It is never selected merely because it exists: the existing ticket-form AI analyzer may recommend it, otherwise the user selects an approach manually.

## Goals

- Ship one pre-built two-phase approach inside the extension.
- Configure provider, model, and effort independently for every workflow phase.
- Automatically replace the active interactive session when the next phase starts.
- Reuse the existing provider registry and shared model catalog.
- Allow custom model identifiers and effort values without maintaining feature-local catalogs.
- Expose each packaged phase prompt in Settings and allow partial edits or complete rewrites.
- Preserve custom prompt overrides across extension and approach upgrades.
- Red-block a phase that cannot launch, then retry from current configuration after the user fixes it.
- Keep phase marks as append-only evidence; never turn an agent-authored mark into a stage verdict.

## Non-Goals

- Automatically selecting the approach when the ticket analyzer did not recommend it.
- Spawning linked child tickets for phases.
- Keeping an orchestrator core alive to launch other agent CLIs.
- Silently falling back to a ticket-level or manifest-level core after a configured phase launch fails.
- Adding a second provider or model catalog for workflow phases.
- Inferring `impl` completion from a terminal exit, hook, or phase mark.

## Built-In Package and Availability

The canonical approach package is tracked with the extension source and copied into the VSIX during build. It contains:

- approach metadata and ordered workflow phases;
- the top-level orchestration skill;
- the Research & Plan phase skill;
- the Implement phase skill;
- the specialized supporting agent prompts used by those phase skills.

The currently ignored `.agents/skills/karst-two-phase/**` tree is force-added to the planning PR so reviewers can inspect the original package in full. Implementation will establish one canonical bundled source directory and a parity test so a reviewable compatibility/source copy cannot drift from what the VSIX actually ships.

The built-in approach appears in Settings → Approaches with an enable/disable control. It is enabled by default but is not `recommended` and does not become the form default. When disabled:

- it is omitted from manual choices for new tickets;
- it is omitted from the ticket analyzer's candidate approaches;
- existing tickets that already reference it remain runnable;
- its package and prompt overrides are retained;
- re-enabling it requires no reinstall.

This behavior prevents a settings change from stranding active work while allowing users who rely only on personal agents to remove the built-in approach from normal selection surfaces.

## Configuration Model

Each workflow phase may carry an optional launch policy:

```yaml
approaches:
  - id: karst-two-phase
    label: Research & Plan → Implement
    enabled: true
    workflow:
      - name: research-plan
        command: /two-phase:research-plan
        agent:
          provider: claude
          model: claude-opus-5
          effort: max
      - name: implement
        command: /two-phase:implement
        agent:
          provider: claude
          model: claude-sonnet-5
          effort: low
```

The built-in package supplies these defaults. Project `karst.yml` entries may override any launch-policy field for a matching built-in phase without copying the whole package.

Resolution is performed at launch time:

1. project phase override;
2. packaged phase default;
3. ticket-level and manifest-level agent settings for any launch field the phase leaves unset;
4. the existing adapter default where no model or effort was resolved.

A phase with an explicit provider never carries an incompatible ticket-level model across providers. The existing provider-aware model compatibility rule remains authoritative.

`provider` must be one of Karst's implemented providers. `model` remains a bounded free-form identifier: Settings offers the existing provider-filtered shared catalog but permits a custom identifier. `effort` is optional and free-form with common UI suggestions (`low`, `medium`, `high`, `max`). The adapter translates effort to provider-native launch arguments. It must not silently discard an explicit unsupported value.

## Prompt Ownership and Customization

Provider/model/effort select the execution core. Phase prompt content is a separate artifact.

The packaged defaults live with the approach, for example:

```text
skills/research-plan/SKILL.md
skills/implement/SKILL.md
```

Settings → Agents includes approach-owned entries such as:

- `two-phase / research-plan`;
- `two-phase / implement`.

The editor displays the complete effective Markdown. The user may change a few lines or replace the prompt completely. Saving a packaged prompt never mutates the extension asset or installed package. Instead, Karst writes a project-local override under the configured `agentsDir` and records its association in `karst.yml`. Reset removes the association and local override, revealing the packaged default again.

Prompt resolution is:

1. project-local phase prompt override;
2. packaged phase skill;
3. configuration error if neither is available.

Approach upgrades replace packaged defaults but preserve project-local overrides. Settings labels the source and indicates when an override is active.

## Automatic Phase Handoff

The first session launches the first declared phase directly with its resolved core, model, effort, effective prompt, and fresh ticket context. It does not launch a generic orchestrator that might repeat already completed work.

When the phase agent is ready to enter the next phase, it invokes the existing `karst phase <name>` command for that next phase. The CLI:

1. validates the phase name at the argv trust boundary;
2. appends the phase mark to SQLite with server-owned attempt and timestamp;
3. notifies the owning extension window through the existing loopback session channel.

The notification is only a wake-up signal. The extension rereads canonical state and verifies:

- the ticket belongs to the current project/window;
- the notifying launch generation owns the ticket's current session;
- the ticket is still at `impl`;
- the selected approach is installed or built in;
- the named phase is declared by that approach;
- the named phase is the valid next phase for the current attempt.

An unknown, repeated, stale, or out-of-order notification does not launch a session. Append-only evidence is retained, and stale-generation events are rejected using the existing session ownership mechanism.

After validation, the host resolves the next phase from current manifest and prompt state, materializes the approach for the target adapter, disposes the old terminal, and opens a fresh terminal that invokes only the next phase. The new launch receives a new generation and cannot resume a session created by another provider.

The final phase still runs the explicit `karst stage impl pass` marker when all implementation work is complete. Neither a phase mark nor terminal closure advances the stage machine.

## Notification Transport

Interactive terminals receive the existing ticket and launch-generation environment plus a bounded loopback callback address. The phase CLI may notify only that local address. The endpoint validates the launch generation from the request target rather than trusting it from an agent-authored body.

The callback handler remains fast and does not perform a long launch while holding the HTTP response. It acknowledges a valid notification, schedules handoff in the extension host, and isolates failures so an endpoint defect cannot stall an agent command.

If the extension is absent or the callback fails after the SQLite write, the mark remains durable. Reload reconciliation reads the latest valid phase mark and restores or blocks the expected phase rather than losing progress.

## Failure and Recovery

A phase launch failure is environmental/configurational, not a failed implementation verdict. Karst parks `impl` with a dedicated red blocker such as `phase-launch-failed`. Reasons are bounded and identify:

- phase name;
- provider;
- model when configured;
- a sanitized failure category or message.

Examples include missing provider binaries, an unavailable provider, an incompatible catalog model, an invalid effort value, a missing prompt artifact, materialization failure, or interactive launch failure. There is no automatic fallback.

The user edits the built-in approach's project override in Settings and presses Resume. Resume clears only this blocker, rereads the latest manifest/catalog/prompt state, and retries the same phase using the updated configuration. It does not append a synthetic phase mark or advance the stage.

If session disposal succeeds but the replacement launch fails, the durable phase mark plus blocker make the resting place explicit. Activation reconciliation never interprets the absent terminal as success.

## Settings Experience

Settings → Approaches shows the built-in approach with:

- built-in/source badge;
- enable/disable toggle;
- ordered phase rows;
- provider picker from the implemented provider registry;
- model picker from the existing live shared catalog, filtered by provider;
- custom model entry;
- effort suggestions plus free-form entry;
- links to edit each effective phase prompt in Agents;
- reset-to-bundled-default controls for launch policy and prompt overrides.

Settings saves remain tab-scoped and merge onto the manifest as it exists on disk at save time. Editing one phase must not revert another phase, another Settings tab, or a concurrently saved agent prompt.

Settings → Agents labels packaged prompts as approach-owned and read-only until customized. Editing creates an override; Reset deletes only the override that Karst created after confirming the exact target.

## Ticket Form and Analyzer

The ticket form offers the enabled two-phase approach in the normal approach picker. No static recommendation flag or default-selection rule is added.

The existing AI analyzer receives enabled approaches as candidates. It may suggest `karst-two-phase`; the host persists that suggestion only under the same non-clobbering rule already used for analyzed ticket fields. An explicit user choice is never overwritten. Disabled approaches are excluded from candidates and rejected if returned by stale analyzer output.

Create and edit modes show the effective phase summary for the selected approach so users can see the two cores before launching, while full configuration remains in Settings.

## Persistence and Compatibility

The feature extends approach/package and manifest workflow metadata; it does not add per-phase columns to tickets. The selected approach remains the ticket identity, while effective phase configuration is resolved from package defaults plus current project overrides.

Existing approaches with phases that omit `agent` remain valid and preserve current single-session behavior. Existing tickets and manifests require no migration. Package readers and writers round-trip unknown-absent optional fields without widening the phase-name command trust boundary.

The append-only `phase_marks` schema remains unchanged unless implementation discovery proves a durable handoff identity cannot be derived from existing `stage_key`, `attempt`, `phase_name`, and insertion order. Any schema change would require a separate migration and explicit justification in the implementation plan.

## Security and Invariants

- `phase` remains a separate CLI parse path and never imports or invokes the stage machine.
- Agent-authored phase names are revalidated on receipt.
- Phase markers cannot supply ticket id, attempt, timestamp, provider, model, effort, stage, callback address, or launch generation through trailing argv.
- The extension resolves launch policy from trusted installed/package and manifest state, never from marker payload text.
- A model or effort value is passed as one adapter argument, never interpolated into a shell command.
- Provider-specific flags stay inside adapters.
- Existing host-agnostic interfaces remain injected and testable without `vscode` at runtime.
- Phase handoff never infers `impl` completion.
- Token usage remains measured once at the adapter seam.

## Verification Strategy

Automated coverage must include:

- manifest and package validation/round trips for optional phase launch policies;
- project-over-package resolution and partial overrides;
- shared catalog reuse, provider filtering, custom model ids, and compatibility checks;
- provider-specific interactive effort translation for every implemented adapter;
- bundled package inclusion in build output and source/package parity;
- built-in enable/disable behavior across Settings, ticket form, analyzer candidates, and existing tickets;
- phase prompt inspection, override creation, full rewrite, reset, and upgrade preservation;
- automatic first-phase launch and cross-provider/model phase handoff;
- current-generation, stale-generation, duplicate, unknown, and out-of-order notifications;
- no verdict/stage transition from phase marks or session closure;
- red blocking on every configuration/materialization/launch failure;
- Resume with changed provider/model/effort/prompt;
- extension reload after durable mark but before or during replacement launch;
- build, typecheck, focused Vitest suites, and the complete `npm test` suite.

## Defaults

The built-in launch defaults are:

| Phase | Provider | Model | Effort |
|---|---|---|---|
| Research & Plan | Claude | `claude-opus-5` | `max` |
| Implement | Claude | `claude-sonnet-5` | `low` |

These are package defaults, not hard-coded launch branches. Users may override every value per project.
