# Inside Redesign — Designer Handoff

**Audience:** Karst product and UI design team
**Purpose:** Design the complete Inside block and the process-assignment Settings UI from the implementation-gap handoff
**Status:** Ready for design exploration; implementation is not complete
**Primary gap inventory:** [`docs/superpowers/specs/2026-08-08-inside-redesign-implementation-gap-analysis.md`](../superpowers/specs/2026-08-08-inside-redesign-implementation-gap-analysis.md)
**Normative implementation plan:** [`docs/superpowers/plans/2026-08-08-inside-redesign.md`](../superpowers/plans/2026-08-08-inside-redesign.md)
**UI constraints:** [`UI-RULES.md`](UI-RULES.md), [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md), [`STYLE-GUIDE.md`](STYLE-GUIDE.md)

## 1. What the design team is designing

Inside is the ticket's execution ledger. Its job is to make the current state, the evidence behind that state, and the next human action legible without asking the user to inspect logs.

The finished presentation has six stages:

`Scope → Implementation → UAT → Review → Ship → Done`

The runtime still contains an internal `fix` stage. In the design it is not a seventh rail stop. A Fix process is inserted immediately after the UAT or Review process that caused it, with a visible causal relationship and revalidation result.

Inside is not a generic analytics dashboard and not a chat transcript. It is a compact, evidence-first ledger of one ticket's work.

### The one-sentence visual thesis

**A quiet execution ledger where status is read first, evidence unfolds in place, and every claim has a visible source.**

The distinctive element should be the causal process rail: a narrow, stable status/timeline spine that makes “what caused this recovery?” obvious without turning the screen into a diagram.

## 2. Non-negotiable product truths

These are design constraints, not implementation details.

- Missing history renders as absence, never as zero, pass, or reconstructed prose.
- AI prose never determines a stage verdict.
- UAT Tester observations are advisory unless a configured host-run verifier supplies a deterministic exit-code result.
- Unknown PR state is unmerged.
- Done appears only after every current PR is literally merged.
- A merge conflict is a waiting/needs-user state, not a failed stage.
- Unsupported interactive token usage is omitted, never shown as zero or estimated.
- Process identity is the identity captured when the process ran, not current Settings.
- The webview receives order, status, aggregation, copy, and action targets from the host. It does not derive them.
- Every interactive target is a semantic button, link, or disclosure.

## 3. Existing Karst visual language to preserve

Do not introduce a new visual framework, palette, or component library. The design team should work inside the current Karst system:

- Self-contained `webview.html` surfaces with injected design-system CSS/JS.
- `--k-*` tokens for color, spacing, type, radius, elevation, and motion.
- `.k-btn`, `.k-iconbtn`, `.k-chip`, `.k-switch`, `.k-input`, `.k-toast`, and other shared primitives.
- VS Code theme variables through the injected design system.
- Sentence case, direct labels, active voice, and error copy in the form “what failed · why · what to do.”
- Hairline dividers and restrained surfaces; no decorative gradients or unrelated illustration language.
- Focus rings, reduced motion, and keyboard semantics as part of the visual design rather than post-hoc accessibility.

Use the existing Settings Agents card and Quality cards as the structural starting point for configuration. Use the current Dashboard Inside block and stage rail as the migration surface, not as a second parallel product.

## 4. Proposed Inside page anatomy

```text
┌────────────────────────────────────────────────────────────┐
│ Ticket title / key                         current operation │
├────────────────────────────────────────────────────────────┤
│ Scope      Impl       UAT       Review       Ship       Done │  ← stage rail
├────────────────────────────────────────────────────────────┤
│ Inside · UAT                              14:02 · 38s · #2  │  ← stage header
│                                                            │
│ ● Gates                 4 passed · 1 failed       [details] │  ← process row
│ │  └─ lint       pass    4.2s                         ›     │
│ │  └─ tests      fail    34.1s     Open log               │
│                                                            │
│ ↳ Fix · UAT gate failure  round 1 of 2             [details] │  ← causal process
│                                                            │
│ ○ Services             waiting for local API       [details] │
│ ○ Tester               not run yet                 [details] │
│                                                            │
│ What happens here: Runs the repo's own test script...      │  ← pending blurb
└────────────────────────────────────────────────────────────┘
```

The top-level process count remains constant as repository count grows. Repository details, findings, and gate rows are bounded and disclosed inside the process row.

## 5. Reusable process-row template

Every process uses one generic outer template. Specialized evidence renderers live inside it.

### Collapsed process row

```text
[status dot] [process label] [AI chip?]        [count/duration] [chevron]
            [short factual detail]             [action, if any]
```

Required visual hierarchy:

1. status and process name;
2. factual detail and current action;
3. identity/token metadata;
4. count and duration;
5. disclosure affordance.

Do not hide status in color alone. Use the existing status ramp and a visible label, icon, or text state.

### Process states

| Status | Meaning | Visual treatment | Example copy |
| --- | --- | --- | --- |
| `pending` | Configured or expected but not started | quiet pending dot, dim metadata | `Will run after gates pass` |
| `run` | Currently executing | running dot/spinner, stable row | `Running` |
| `wait` | Human/external condition blocks progress | attention ramp, no failure icon | `Waiting for merge` |
| `pass` | Explicit successful result | passed ramp and factual result | `4 gates passed` |
| `fail` | Deterministic or explicit failed result | failed ramp and recovery/action context | `Tests failed` |
| `note` | Informational or unsupported fact | neutral/info treatment | `No token usage recorded` |
| `skip` | Deliberately disabled or withdrawn | quiet skip treatment, reason visible | `Disabled for this ticket` |

The row's disclosure must be a real `<details>/<summary>` or an equivalent keyboard-complete button with `aria-expanded`.

### Process identity template

For AI processes, place one compact identity cluster after the process name:

```text
[agent icon] Review Agent · Codex · sol     1.8k tokens
```

Rules:

- Show the captured execution identity, not the current Settings selection.
- Use the existing agent identity injection and model catalog labels.
- If identity was never recorded, omit the cluster rather than filling in current defaults.
- If tokens are unsupported, omit token UI or use a factual note such as `Token usage not available for this provider`.
- Keep token metadata secondary to process status.

## 6. Stage templates

### Scope

Top-level processes:

- `Hot set`
- `Worktrees`

Design intent: show what repositories are included and whether worktrees were prepared. Details may list repositories, but the top-level ledger should not become one row per repository.

Suggested empty/pending copy:

> Validates the selected repositories and creates one worktree per hot repository after confirmation.

### Implementation

Top-level process:

- `Session`

Inside the disclosure, render a provider-segment timeline:

```text
● Codex · sol                 12:03–12:18       3.2k tokens
│  Session started · 4 phase marks
│
↳ Claude · opus               12:18–12:31       usage unavailable
   Switched provider · 2 phase marks
```

The switch arrow is a relationship marker, not a new stage node. A provider switch creates a new recorded segment inside one Karst Implementation run.

Pending copy must distinguish configuration from execution:

> Implementation agent: Codex · sol

This is configured identity, not evidence that the process ran. Label it accordingly.

### UAT

Stable process order:

1. `Gates`
2. conditional causal `Fix`
3. `Services`
4. `Tester`

The Fix row is inserted immediately after its trigger. It must not appear at the bottom as an unrelated retry meter.

Gate evidence template:

```text
Gates                         4 passed · 1 failed
  lint                         pass · 4.2s
  typecheck                    pass · 8.1s
  test                         fail · 34.1s         Open log
  optional-e2e                 skip · disabled
```

Tester template:

```text
Tester · UAT Agent · Codex · sol        note
  2 observations · verifier not configured
  Findings are advisory and did not affect UAT.
```

If a deterministic verifier exists:

```text
Tester                                      fail
  2 observations · verifier exit 1          Open evidence
  Verification failed; recovery is available
```

### Review

Stable process order:

1. `Gates`
2. `Services`
3. `Review`
4. conditional causal `Fix`

Findings template:

```text
Review · Review Agent · Codex · sol       2 blocking
  2 findings · 1 repository                Open findings
```

Expanded findings should show at most six rows before a `Show all findings` continuation action. Each row should expose severity, title, repository/file context, and a host-authorized file action when available.

Review execution failure must not render as “no findings.” Use a distinct failure row:

> Review execution failed: the agent did not return a result. Retry review.

### Ship

Stable process order:

1. `Commit`
2. `Push`
3. `PR`
4. `Merge`

Ship is per-repository evidence aggregated into those four process rows. Do not render a repository list as four copies of the whole stage.

Suggested expanded repository template:

```text
Ship
  api
    Commit     passed · created by Karst       abc1234
    Push       passed · origin/develop         Open log
    PR         #413 · open                     Open PR
    Merge      waiting                         Click Merge
  web
    Commit     note · no changes
    Push       note · not required
    PR         note · no PR created
    Merge      note · nothing to merge
```

Important distinctions:

- `note` for no changes is not a failure.
- An open PR is not merged.
- Unknown PR state is unmerged.
- A conflict is `wait`/needs-user, not `fail`.
- Adopted human work must be labeled as adopted/pre-existing, never “created by Karst.”

The PR-description AI process is evidence attached to the PR operation, not a fifth Ship stage.

### Done

Top-level process:

- `Delivery receipt`

Receipt template:

```text
Delivery receipt                         passed
  2 current PRs merged
  3 repositories shipped
  1 recovery round completed
  4.8k recorded tokens
  Delivered 12:42
```

If required facts are absent, omit them. Do not show `0 tokens` for an unsupported or unrecorded provider.

Done is a receipt for an already-accepted terminal state; it is not an action-oriented execution stage.

## 7. Settings template: process assignment configuration

This is the currently missing UI called out in the gap analysis. Add it to the existing Settings → Agents section using the current Agents card/list visual grammar.

### Information architecture

Keep existing role-based agent profiles and add a separate “Inside process assignments” subsection. Do not add provider/model fields to the existing `AgentDef`; that object represents a prompt/profile, not an execution assignment.

```text
Agents
  Agent profiles
    [existing agent list and add-agent controls]

  Inside process assignments
    UAT Tester       [agent profile] [provider] [model] [enabled]
    UAT Fix          [agent profile] [provider] [model] [enabled]
    Review           [agent profile] [provider] [model] [enabled]
    Review Fix       [agent profile] [provider] [model] [enabled]
    PR description   [agent profile] [provider] [model] [enabled]

  [Save changes]
```

### Assignment row template

```text
┌──────────────────────────────────────────────────────┐
│ UAT Tester                                  [enabled] │
│ Agent profile   [ UAT Agent             ▾ ]           │
│ Agent core      [ Codex                ▾ ]           │
│ Model           [ sol                  ▾ ]           │
│ Runs after required UAT gates pass                    │
└──────────────────────────────────────────────────────┘
```

Recommended labels:

- **Agent profile** — the reusable role/prompt definition.
- **Agent core** — the provider executable/service, e.g. Codex or Claude.
- **Model** — a model compatible with the selected core.

Avoid exposing raw manifest terms such as `uatTester` as the primary label. The manifest key can appear in a developer tooltip or documentation, not as user-facing copy.

### Assignment states

| State | UI behavior |
| --- | --- |
| Valid configured assignment | Show selected profile, core, model |
| Assignment omitted | Show approved default and a `Default` hint |
| Disabled | Preserve selections but disable execution; explain what will be skipped |
| Unknown profile | Inline error naming the missing profile |
| Unknown provider | Inline error and no model picker claim |
| Model incompatible with provider | Inline error; do not silently substitute |
| Provider catalog unavailable | Keep saved id, show unavailable note, allow save only if validation policy permits |
| Unsaved edits | Existing tab-scoped dirty state and leave confirmation |

The model picker must use the host-supplied catalog. There must be no model literals in the HTML.

### Defaults and historical identity

The settings view may show defaults for future execution, but it must never imply that a historical process used that default. Inside rows use recorded execution snapshots; Settings uses current configuration.

## 8. Live operation template

While an operation is running, the stage header may show one current process:

```text
Inside · Review                    ● Running · Review Agent · Codex · sol
                                     [spinner] Running review findings
```

When the process completes, the host sends a completed process view and the normal snapshot becomes authoritative. When work is cancelled or superseded, the host clears the live header without inventing a pass or fail.

The live header must not become a second process row or a second business-rule implementation in the webview.

## 9. Action and disclosure templates

Actions are host-owned capabilities represented visually by familiar controls:

| Visual action | Process evidence | Control |
| --- | --- | --- |
| Open PR | current recorded PR | `<a href>` or semantic button routed by host |
| Open commit | recorded Ship commit | semantic button/link |
| Open file | recorded finding/evidence row | semantic button; host revalidates path |
| Open stage log | recorded stage/process evidence | semantic button |
| Resume stage | eligible blocked stage | semantic button with pending state |
| Open full evidence | bounded list continuation | semantic button with pending state |

The browser message carries only an opaque `actionId` and the presentation `kind`. It must never carry a client-supplied path, URL, PR number, SHA, repository, or stage as authority.

For every async control, design all three states:

```text
Idle       [Open log]
Pending    [spinner] [Open log]      aria-busy + disabled, same label
Completed  [Open log]                visible terminal result/toast if needed
Unknown    [Open log]                “Result unknown — try again”
```

Use the shared Karst async-action runtime and existing button primitives.

## 10. Responsive templates

The Inside component must remain readable at 300, 360, 430, and normal widths.

### Normal width

- Stage rail shows all six labels.
- Process row has status/name, detail, identity, metadata, and disclosure on one or two lines.
- Expanded evidence uses the available width for repository/file context.

### Narrow width

- Keep status and process name first.
- Move identity and token metadata to a second line.
- Allow PR title/branch content to wrap.
- Keep the timeline rail in the same token-backed cell and preserve node/edge alignment.
- Do not introduce whole-component horizontal scrolling.
- Do not hide the only status or action to make a row fit.

### Scale behavior

Top-level process count is constant for 2, 5, 10, 15, and 20 repositories. Use bounded previews:

- repository details: six visible before continuation;
- findings: six visible before continuation;
- gate evidence: eight visible before continuation.

Continuation controls must say exactly what they reveal, for example `Show 8 more repositories`.

## 11. Copy templates

Use sentence case and direct verbs.

### Pending

- `Has not run yet`
- `Will run after required gates pass`
- `Waiting for merge`
- `No changes to ship`

### Absence and unsupported data

- `No token usage recorded yet`
- `Token usage not available for this provider`
- `No PR was created because this repository had no changes`
- `No historical execution identity recorded`

### Failure

- `Tests failed: 1 gate returned a nonzero exit code. Review the log and resume the stage.`
- `Review execution failed: the agent did not return a result. Retry review.`
- `Ship is waiting: resolve the merge conflict before the ticket can be done.`

### Recovery

- `Fix started after UAT test failure · round 1 of 2`
- `Fix completed; UAT revalidation is running`
- `Recovery exhausted after 2 rounds. Resolve the remaining failure manually.`

Do not use “AI says,” “probably,” or vague “Something went wrong” copy. Do not use a success color for an informational/no-change state.

## 12. Design deliverables requested from the team

Please return the following artifacts for implementation:

1. Desktop and narrow-width layouts for the complete Inside block.
2. Collapsed and expanded variants for every generic process row.
3. Specialized evidence states for gates, timeline, findings, Ship repositories, recovery, and Done receipt.
4. All statuses: pending, running, waiting, pass, fail, note, skip.
5. Live operation, async pending, terminal success, terminal failure, and unknown-result states.
6. Settings → Agents process-assignment UI with valid, disabled, missing, and catalog-error states.
7. Keyboard focus, disclosure, link, button, and reduced-motion behavior annotations.
8. Copy deck for empty, absent, unsupported, waiting, failed, recovered, and exhausted states.
9. A token/primitive inventory identifying any genuinely new design-system requirement.
10. Fixtures or annotated examples for 2, 5, 10, 15, and 20 repositories.

## 13. Acceptance checklist for design review

### Product truth

- [ ] The six presentation stages are clear and runtime `fix` is represented causally, not as a seventh stage.
- [ ] A user can distinguish pending, waiting, failure, absence, skip, and unsupported data.
- [ ] Done reads as a delivery receipt and cannot appear before all current PRs merge.
- [ ] AI findings are visibly distinct from deterministic verdicts.
- [ ] Historical execution identity is visually separate from future Settings configuration.

### Configuration

- [ ] UAT Tester, UAT Fix, Review, Review Fix, and PR description each have a visible assignment row.
- [ ] Agent profile, Agent core, and Model are clearly different controls.
- [ ] Provider/model choices are catalog-driven and provider-compatible.
- [ ] Defaults and disabled states are understandable without exposing implementation jargon.
- [ ] Settings save/dirty/validation behavior follows existing tab-scoped Settings patterns.

### Interaction and accessibility

- [ ] Every action uses the correct semantic element.
- [ ] Every async action has idle, pending, terminal, and unknown-result states.
- [ ] Disclosure state is keyboard-accessible and survives ordinary rerenders.
- [ ] Focus remains visible in every theme.
- [ ] Reduced motion removes animation without removing visible state.
- [ ] Untrusted titles, paths, findings, and CLI prose are shown escaped.

### Scale and layout

- [ ] Top-level process count remains stable as repositories increase.
- [ ] Repository, finding, and gate bounds are visible and discoverable.
- [ ] Layout works at 300/360/430px without whole-component horizontal scrolling.
- [ ] Timeline node and edge remain aligned at every supported width.

### Engineering handoff

- [ ] Every visual value maps to an existing `--k-*` token or has a proposed design-system addition.
- [ ] No new UI framework or runtime dependency is required.
- [ ] No webview business-rule derivation is needed to reproduce the design.
- [ ] Each action can be represented by the typed `InsideActionKind`/opaque action contract.
- [ ] Each renderer can consume one `ProcessEvidenceView` union member without parsing prose.

## 14. Open design decisions

The following should be resolved before final visual approval:

1. Should process assignments appear as five compact rows or five expandable cards on the Agents tab?
2. Should Fix rows inherit the parent process identity visually, or show their own dedicated Fix assignment chip plus a “caused by” label?
3. Should the stage rail show text labels at the narrowest width, or collapse to accessible icons with an adjacent selected-stage label?
4. Should the Done receipt use a compact summary card or remain a normal process row with a receipt disclosure?
5. Should “show all” open inline, replace the disclosure content, or navigate to a dedicated evidence view?
6. How prominently should unsupported token usage be explained without making the normal process row feel like an error?
7. Should adopted/pre-existing Ship artifacts receive a dedicated provenance badge or factual inline label?

Design decisions must preserve the product truths in Section 2 even when visual options differ.

## 15. Implementation mapping

| Design surface | Planned implementation tasks |
| --- | --- |
| Process contract and generic row | 1, 10–14 |
| Process-assignment Settings UI | 7 |
| Implementation timeline | 4, 5, 10, 15 |
| UAT Tester and verifier | 7, 8, 11, 15 |
| Review findings and explicit outcomes | 3, 7, 8, 11, 15 |
| Causal Fix row | 6, 11, 15 |
| Ship provenance | 9, 12, 15 |
| Done receipt | 3, 5, 12, 15 |
| Live operation header and actions | 13, 14 |
| Responsive/accessibility fixtures | 16 |

The designer handoff is complete when the team can hand implementation a screen/state matrix and token-backed component specs without asking the webview to infer business state.
