# karst.yml → Settings UI coverage

Inventory of every key the manifest schema accepts, mapped to the Settings tab that
edits it. Sources of truth: `src/manifest/types.ts` + `src/manifest/validate/*`
(what the file may contain), `src/ui/settings/sections.ts` (what Save owns) and
`src/ui/settings/webview.html` (what is actually rendered).

Nothing is silently lost by a gap: `writeManifest` (`src/manifest/write.ts:129-165`)
overlays `id`, `uat` and `review` on every save, and Save is tab-scoped, so a
yml-only key survives editing in the UI. One exception, below.

Legend: **UI** = editable in Settings · **GAP** = yml-only.

## Covered

| Key | Tab |
|---|---|
| `host`, `portRange`, `baselineBranch`, `worktreePathDisplay`, `agentProvider`, `defaultModel`, `ticketLabelTemplate`, `terminalNameTemplate` | General |
| `conventions.branchName` / `.commitMessage` / `.pullRequestTitle` / `.pullRequestDescription` / `.defaultType` | Git (+ presets) |
| `repositories.<n>.repoPath` / `.baselineBranch` / `.hasMigrations` / `.signals` / `.enabled` | Repositories |
| `repositories.<n>.service.start` / `.health` / `.ports[].{name,env,default}` / `.dependsOn[].{target,port}` / `.dependsOn[].bind[].{env,template}` | Repositories |
| `approaches[].id` / `.label` / `.description` / `.entrypoint` / `.recommended` / `.enabled` / `.source` (git: repo/ref/include; npm: package/command/collect) | Approaches |
| `agents.<n>.enabled` | Agents |
| `ticketing.provider` / `.teamId` / `.listId` / `.advanceOnStart` / `.startStatus` / `.advanceOnShip` / `.shipStatus` | Ticketing |

## Gaps

### 1. `uat:` — entire block, zero UI — and most of it is INERT

No file under `src/ui/` references `manifest.uat`. But before asking which parts
deserve a UI, note that most of the block has no consumer anywhere: it is parsed by
`validateUat`, written back by `writeManifest`, and never read.

| Key | Consumer |
|---|---|
| `uat.maxFixAttempts` | **wired** — `workflow/driveTicket.ts:43` (per-gate fix budget) |
| `uat.gates[]` | **wired** — `workflow/uat/gates.ts` |
| `uat.repositories.<n>.gates` | **wired** — same, as a REPLACE override |
| `uat.testDir`, `uat.repositories.<n>.testDir` | none |
| `uat.env`, `uat.repositories.<n>.env` | none |
| `uat.secrets`, `uat.repositories.<n>.secrets` | none |
| `uat.passthrough` | none |
| `uat.origins` | none (CLAUDE.md: inert until Phase 2) |
| `uat.authBootstrap.{path,secrets}` | none (same) |
| `uat.author.{agent,enabled}` | none |

Grep basis: every match for these names outside `validate/uat.ts`, `manifest/types.ts`,
`manifest/fixtures.ts` and tests is either a comment or an unrelated identifier.

This is the answer to "how does a user configure `uat.secrets`?" — they cannot, in
any sense that has an effect. Writing it is accepted and does nothing.

### 2. `review:` — entire block, zero UI

`maxFixAttempts`, `requireIndependentSignal`, `gates[]` (same shape as UAT's minus
`report`), `findings.{enabled,blockingSeverity,maxFindings}`, `repositories.<n>.gates`.

Same: no UI reference anywhere.

### 3. `id:` (project identity)

Deliberately unlisted in `SECTION_FIELDS`. Changing it starts a fresh empty board.
Not editable — but currently not *visible* either, which is the actual gap: there
is no surface that answers "is this window bound to the project I think it is?"

### 4. `repositories.<n>.scope`

The conventional-commit `{scope}` override. The Git tab's templates *offer*
`{scope}` and preview it, but the repo card has no field to set it — so a user who
picks the `{type}({scope}): …` preset can only get the manifest repository name.

### 5. `agents.<n>.role` / `.command` / `.promptPath`

The Agents tab is an enable/disable roster plus a body editor for file-backed
agents. The manifest `AgentDef` fields themselves are not editable.

### 6. `approaches[].workflow` — GAP **and destructive**

Phases (`name`/`command`/`description`) have no editor, and the approach drawer's
save (`webview.html:2428-2436`) rebuilds the approach object from drawer fields
only, carrying nothing from `existing` except `enabled`. Editing a workflow-bearing
approach (e.g. the shipped `rpi`) through the UI **deletes its `workflow`**.
Untouched approaches are unaffected — the draft carries them through verbatim.

## How yml-only keys are set up today

Worth stating before recommending anything stay yml-only, because it turns out to
be barely a path:

- **No command opens the manifest.** `package.json` contributes 22 `karst.*`
  commands; none is an "Open karst.yml".
- **No surface shows where it is.** The host knows the resolved path
  (`ui/settings/panel.ts:51` → `actions.ts:15`) and never renders it. The only
  pointer is the `karst.manifestPath` VS Code setting (default `./karst.yml`).
- **Feedback is post-hoc.** A bad edit surfaces as an `Invalid karst.yml: …` banner
  in Settings, after saving, with no field to correct it in.
- **The one real aid is `karst.example.yml`**, which is thorough — but it is a
  repo-root file the user has to know exists.

So "yml-only" currently means "hand-edit a file the UI never mentions." That is a
fine story for a key a team sets once at bootstrap from the example file; it is a
poor one for anything touched during normal use.

## Recommendation

**Fix now (defect, not a feature):** #6. Spread `...existing` (or explicitly carry
`workflow`) in the approach drawer save. Silent config loss on an ordinary edit.

**Prerequisite for anything staying yml-only:** an "Open karst.yml" command plus the
resolved path shown in Settings. One command and one line of text; it is what makes
every exclusion below an actual choice rather than a dead end. Without it, prefer
exposing the key.

**Worth UI exposure:**

- **`id` — READ-ONLY display.** Not a field; a fact the General tab states. Tickets
  are project-scoped and the DB is shared across IDE windows, so "which project is
  this window on" is otherwise unanswerable from the UI — and when the manifest
  carries no `id`, the host silently falls back to a path-derived slug
  (`resolveProjectSlug`), which changes if the repo moves. Render the RESOLVED slug
  plus its provenance (manifest vs. derived), not the raw key: a derived slug is
  the case a user most needs to see, and it is not in the file at all. No input, no
  `SECTION_FIELDS` entry — it must stay out of the tab-scoped write path so Save
  can never carry it.
- **`review.findings`** (`enabled`, `blockingSeverity`, `maxFindings`) — the one
  knob that changes whether review *blocks*. Default is deliberately non-advisory
  (on / `high`), which is exactly the kind of policy a team wants to dial without
  hand-editing yml. Small, closed-vocabulary, three controls.
- **`review.gates` / `uat.gates`** — the gate list is the most-touched part of both
  blocks (add a lint script, scope one to a repo) and it is already a repeating
  form karst renders well elsewhere. Reuse one gate editor for both; the shapes are
  identical apart from UAT's `report`.
- **`repositories.<n>.scope`** — a one-line text input on the repo card. Cheap, and
  it closes a hole the Git tab already advertises.
- **`uat.maxFixAttempts` / `review.maxFixAttempts`** — single integers, directly
  affect how long a stuck ticket churns.
- **`uat.repositories` / `review.repositories` per-repo gate overrides** — same gate
  editor as above, scoped by an existing repo picker. Note the REPLACE (not additive)
  semantics must be stated in the UI copy, or the override reads as "add one gate".

**Do not build UI for (yet) — the key does nothing:**

`uat.testDir`, `uat.env`, `uat.secrets`, `uat.passthrough`, `uat.origins`,
`uat.authBootstrap`, `uat.author`, and the per-repo `env`/`secrets`/`testDir`
overrides have no consumer (table above). A form for these would promise behavior
that does not exist — strictly worse than the current silence, which at least fails
honestly. The real defect here is not the missing UI: it is that the manifest
ACCEPTS config it ignores, with no warning. Two options, and the choice belongs to
whoever owns UAT Phase 2:

1. Keep parsing them as the forward-compatible placeholder they are, and say so —
   a load-time INFO ("declared but not yet active") or, at minimum, a comment in
   `karst.example.yml` marking the inert block. Cheap; stops the silent no-op.
2. Drop them from the validator until the feature lands, and re-add with the
   consumer. Loudest, and consistent with the codebase's own rule against
   speculative keys (`ReviewConfig`: "No `approval` key … do not add one
   speculatively").

### Secrets DO get a UI — the pattern already ships

Nothing about secrets argues against a UI. karst already has the right one, for the
ClickUp token, and it generalizes directly:

- webview posts a bare `{type:'set-token'}` — **no payload** (`messages.ts:19`);
- the host opens `vscode.window.showInputBox({password:true})` and stores the value
  in the OS keychain (`extension.ts:1128` → `secretStore.ts`);
- the webview only ever receives `tokenConfigured: boolean` (`state.ts`), and renders
  a status pill plus **Set token** / **Clear token**.

The secret never enters the manifest, the draft, the DB, or a log. Applied to UAT:
`uat.secrets` stays a list of NAMES in yml (a name is not a secret, and the list is
legitimately per-project, diffable config), and each name gets a row with the same
pill + Set/Clear. That is a better UX than yml editing, not a compromise.

Two things must land first, in order:

1. **A consumer.** Nothing reads `uat.secrets` today (table above), so a Set button
   would store a value nothing injects.
2. **A keyed secret store.** `secretStore.ts` is single-purpose — one hardcoded
   `CLICKUP_TOKEN_KEY`, `set/has/clear` with no name parameter. It needs a
   keyed-by-name API (namespaced, e.g. `karst.uat.secret.<name>`) before more than
   one secret can exist.

Sequence: consumer → keyed store → UI. The blocker is plumbing, never a policy
against secret entry in the UI.

**Keep yml-only — and the reason has to be stronger than "advanced":**

Three criteria justify exclusion. "Rarely touched" is not one of them; that argues
for a good default, not a hidden key.

1. *Exposing it makes a dangerous mistake easier.*
   - **Secret VALUES in the manifest draft.** To be precise, since this is easy to
     misread: entering secrets through the UI is fine and is the recommendation.
     What must never exist is a value that travels through the settings DRAFT — the
     object the webview holds and Save writes to `karst.yml`, a committed file.
     `validateUat`'s `keyNameList` refuses a mapping-with-values for that reason.
     The entry UI simply does not route through the draft; see the token pattern
     above.
2. *A UI can author something that cannot be valid.*
   - **`approaches[].workflow`** — every `command` must resolve against a fetched
     artifact or install fails. A free-text phase editor lets a user write a dangling
     command that only breaks later, at install. Fix the clobber; do not build the
     editor.
3. *It is identity, not configuration.*
   - **`id` as an EDITABLE field** — an input invites the one edit that orphans a
     board. Read-only display only (above).

**Genuinely undecided — do not treat as settled:**

- **`agents.<n>.role` / `.command` / `.promptPath`** — I called these "internal
  wiring", but `AgentDef.command` is optional specifically so a role can be declared
  before its runner is wired, which implies someone wires it later, by hand, with no
  affordance. Either expose them on the Agents tab or accept that declaring an agent
  is a file-editing task and say so in the docs. Worth a decision, not a default.
- **`review.requireIndependentSignal`** — a single boolean that changes what review
  accepts as proof. Excluded above only by omission; it is as user-facing as
  `review.findings.enabled` and probably belongs beside it.

## Settled — no decision needed, just build it this way

These have a determined answer from existing code or an invariant already in
`CLAUDE.md`. Recorded so nobody re-opens them mid-implementation.

**S1. Fix the approach-drawer clobber.** `webview.html:2428-2436` — carry `workflow`
(and anything else `existing` holds) through the rebuild. Bug, not a design choice.

**S2. One gate editor, parameterized by block.** `uat.gates` and `review.gates` are
the same shape and already share `validateGate`. Two components would fork on
validation, copy and repo-scoping and never remerge.

**S3. Per-repo gate overrides REPLACE, and the UI must show it.** Already the
semantics (`declaredGatesFor` / `declaredReviewGatesFor`, mirrored in `CLAUDE.md`).
A per-repo list *reads* as "add a gate here", so the override editor opens pre-filled
with the global list — replacement is then visible rather than implied by copy.

**S4. Controls render the manifest's own defaults.** `review.findings` defaults to
`enabled: true` / `blockingSeverity: 'high'` (a deliberate deviation from the design
spec's advisory recommendation). An absent block must render as blocking, because
that is what it does. Anything else is a display bug.

**S5. Keychain keys are project-scoped:** `karst.<projectId>.uat.secret.<name>`. The
DB is shared across IDE windows and everything ticket-related is project-scoped; a
global key would leak one project's credential into another's UAT run. Must be
chosen with the keyed-store API — a later rename orphans entries the UI can no
longer see or clear.

**S6. `id` is displayed, never editable**, and shows the RESOLVED slug plus
provenance (manifest vs. `resolveProjectSlug` fallback). No `SECTION_FIELDS` entry.

**S7. Secret values never enter the settings draft.** Entry is the token pattern
(bare message → host `showInputBox` → keychain → webview sees a boolean). This is a
rule about routing, not a limit on the feature.

## Decided

**D1. Inert config is KEPT and MARKED, not dropped. — decided**

Keys the manifest accepts but no code reads stay in the validator and stay in
`writeManifest`'s overlay, so no existing `karst.yml` breaks and nothing is erased
on Save. What changes is that they stop being silent: a load-time INFO names each
declared-but-inactive key, and `karst.example.yml` annotates the inert blocks.

Rejected: *drop until wired* — principled (it is `ReviewConfig`'s own stated rule)
but `schema.ts` ignores unknown keys rather than rejecting them, so a user's existing
`uat.secrets` would load as nothing and then be erased by the next tab-scoped Save;
making that safe costs a migration, which is most of the work. Rejected: *wire them
now* — right eventually, but it front-loads Phase 2 decisions (how env reaches a gate
process, where origins are enforced) that have not been made.

This forecloses nothing: both alternatives remain open later, now with users warned.

Applies to (current inventory): `uat.testDir`, `uat.env`, `uat.secrets`,
`uat.passthrough`, `uat.origins`, `uat.authBootstrap`, `uat.author`, the per-repo
`env`/`secrets`/`testDir` overrides, and `AgentDef.role`/`.command`/`.promptPath`.

Implementation notes: reuse the INFO/WARN split already established by
`catalogDiagnosticSeverity` (`agent/modelCatalogLoader.ts`) rather than inventing a
second severity vocabulary — a declared-but-inactive key is INFO, exactly like a
catalog tier that declines. Key names are manifest-authored, so they are a closed
set (the validator's own field list), never interpolated from arbitrary input.

**D2. `AgentDef.role` / `.command` / `.promptPath` follow D1. — decided**

Same disease, same rule: kept, marked inactive by the load diagnostic. Not shrunk to
`{enabled}` and not exposed in the UI.

Both alternatives presume an answer to a prior question nobody has asked out loud —
*is the role-keyed declared-agent model still intended, or has the Agents-tab roster
replaced it?* Shrinking forecloses it before Phase 2 rules; exposing it in the UI
builds a form whose values change nothing, which is the exact failure this report
documents. Settle the model with evidence in Phase 2.

One wrinkle to carry: `role` is **required** by `schema.ts:136` while being read by
nothing, so authors are compelled to supply a value that misleads them. The INFO
should say so explicitly.

**D3. One "Quality" tab, rendering wired keys only. — decided**

A single settings tab owns both `uat` and `review`, and renders ONLY keys with live
consumers: `uat.maxFixAttempts`, `uat.gates`, `review.maxFixAttempts`,
`review.requireIndependentSignal`, `review.findings`, `review.gates`, plus per-repo
gate overrides for both.

The two blocks are read together (a ticket passes UAT, then review), neither fills a
page alone, and the shared gate editor (S2) gets one obvious home. Rendering only
wired keys is what keeps this consistent with D1: no inert key gets a control, so
the tab cannot promise behavior that does not exist.

Rejected: *two tabs* — roomier for Phase 2's uat surface, but two thin pages today
and a gate editor that looks duplicated, inviting exactly the fork S2 exists to
prevent. Rejected: *defer entirely* — leaves `review.findings`, the knob deciding
whether review BLOCKS, hand-edited.

Still ship the discoverability fix alongside it (`karst.openManifest` + the resolved
path in Settings): the Quality tab deliberately does not cover the inert keys, so
hand-editing has to be a real path.

**Cross-cutting:** if `uat`/`review` gain any UI, they need entries in
`SETTINGS_SECTIONS` / `SECTION_FIELDS` (`sections.ts`), mirrored into
`webview.html`'s `SECTION_FIELDS` copy, or tab-scoped Save will not write them —
`sections.test.ts` pins the one-section-per-field split, and `webview.test.ts` pins
the mirror.
