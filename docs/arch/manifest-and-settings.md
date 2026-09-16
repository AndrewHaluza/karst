# The manifest (`karst.yml`) and the Settings panel

What the manifest models, and the rules that keep a Settings write from silently reverting another tab. Related: `docs/arch/worktrees-and-servers.md` (the conventions block), `docs/arch/agent-cores.md` (the profile body an assignment resolves to).

## Contents

- A Settings process-assignment profile IS the process's prompt
- Settings Save is TAB-SCOPED
- A REPOSITORY is the primary entity; a SERVICE is an optional relation
- Legacy services: manifests migrate IN MEMORY
- `uat.testerObservations.blockingSeverity` is a manifest knob only
- New Manifest field checklist

## A Settings process-assignment profile IS the process's prompt

`processes.<key>.agent` names a profile from the agent POOL (a file agent or an approach artifact), and the profile's BODY — its custom prompt — is resolved at the execution boundary (`processFor` in `extension.ts`, through `soloAgentBody`, the SAME resolver the single-subagent launch path uses) and overlaid as the assignment's `instructions`. For `uatTester` and `review` this replaces the built-in role/strategy block; for `ticket-analysis` the body drives the description-improve sub-pass (the classify sub-pass is always the built-in analyzer). The profile body is the ONLY prompt source: the inline `processes.<key>.instructions` override (and its Settings textarea) is RETIRED, because two ways to say the same thing let a line in the yml silently outrank the profile the row was showing. No profile / an unreadable one → the built-in prompt. The retired key still LOADS (`inertKeys.ts` reports it as retired and names the replacement) and is simply dropped — never an error. `PROMPT_BEARING_ROLES` lives in `manifest/validate/processAssignments.ts` beside the role vocabulary; `webview.test.ts` pins the mirror. Wiring status: the profile body reaches the prompt-BEARING roles — `ticket-analysis` (description-improve pass), `uatTester`, `review`. The interactive Fix roles (`uatFix`/`reviewFix`) and `prDescription` consume only the profile's provider/model/name snapshot. The ticket's own `single-subagent` approach+agent drives the SESSION, never the headless analysis.

## The prompt-contract floor: what a profile override cannot displace

A profile replaces the **strategy** block (the persona, behavior instructions, and role lines). It never replaces the **contract** block — the invariants that protect correctness beyond the prompt's own call site. Each prompt-bearing surface defines its own floor:

- **Ticket analysis** (`workflow/classify/analyze.ts`): the contract block is always composed after the strategy. It requires the synthesized prompt to be approach-agnostic and service-agnostic (WHAT/WHY, not HOW; no repos, services, or paths). This protects against a thin profile producing a prompt that hard-codes a workflow — the damage would only show up later, on a ticket whose approach changed, because the prompt is NOT regenerated when the user re-picks approach or services.

- **UAT Tester** (`workflow/uat/tester.ts`): the floor is the output rules (`OUTPUT_RULES_HEADING`/`OUTPUT_RULES_BASE`/`OUTPUT_RULES_UAT`), the scope block (`buildScopeBlock`), the criteria block (`buildCriteriaBlock`), and the "OBSERVATIONS, not verdicts" constraint. These are appended after the strategy lines, so `instructions` only ever replaces the strategy — displacement is a test failure, not a construction-order accident.

A three-line process profile that replaces the entire prompt (strategy + contract) would degrade correctness invisibly. The floor mechanism ensures the contract always ships, regardless of what the profile body contains.

## Settings Save is TAB-SCOPED, and the tab's fields are the whole write

`ui/settings/sections.ts` owns the split (`SECTION_FIELDS`, one section per manifest key; `mergeSection` overlays just that section) and `actions.ts`'s `save` merges the posted draft onto the manifest **as it is on disk right now**, then validates the MERGED result — so validity is judged on exactly what would reach the file. An unknown `section` on the message is DROPPED, never downgraded to a whole-manifest save — widening the write is the thing being prevented. `id`/`uat` belong to no section and always survive from the base. The webview mirrors `SECTION_FIELDS`/`SECTION_LABELS` (it cannot import TS) and `webview.test.ts` runs its `overlaySections` against the host's `mergeSection`; it also validates the per-tab CANDIDATE rather than the raw draft, so an unfinished edit parked on another tab cannot block this one. Leaving a dirty tab opens the page-local confirm (`requestSection`). A ManifestError arrives as `message`, i.e. prefixed `Invalid karst.yml…`; strip it once via `manifestFaultDetail` before any pattern match.

## A REPOSITORY is the primary entity; a SERVICE is an optional relation on it

`karst.yml` has `repositories:`; `start`/`health`/`ports`/`dependsOn` live under an optional `service:` block, so "port without a runnable process" is unrepresentable. `repoPath`/`hasMigrations`/`signals` stay repository-level — they describe the source tree and stay true whether or not anything runs. Gate on runnability ONLY via `manifest/runnable.ts` (`isRunnable` is a type guard, so `service` needs no `!`); scattering `?.` at call sites is how `svc.ports[0]!` used to throw. Non-runnable repos ARE scoped, DO get a worktree, and are absent from `ResolveResult.services`/`startOrder` — `ResolveResult.nonRunnable` names them so consumers state it rather than infer it from an absence.

## Repository keys must be distinct CASE-INSENSITIVELY

A graph document claims repositories by canonical (case-folded) id, so `BE:` and `be:` in one manifest would be one ambiguous target downstream. `assertDistinctRepoIds` (inside `validateManifest`) refuses the pair, naming the fix: rename one key and every reference to it. This is a load-time refusal — a pre-existing manifest carrying two case-variant keys stops loading entirely (the extension is disabled for that project) rather than failing only its graph runs, which is deliberate: the ambiguity is not confinable to graphs.

## Legacy `services:` manifests migrate IN MEMORY

Legacy `services:` manifests migrate IN MEMORY (`manifest/migrate.ts`) + warn; `writeManifest`/`writeRepoSignals` upgrade the file on the next explicit save. Loading never writes (js-yaml drops comments). A file with BOTH keys is refused, never guessed. `ManifestError.withPath` attaches the file — validators only know field names, and a user may have several manifests.

## `uat.testerObservations.blockingSeverity` is a manifest knob only

`UatConfig.testerObservations?.blockingSeverity` (`Severity | 'none'`, validated in `manifest/validate/uat.ts` against the same closed vocabulary as `review.findings.blockingSeverity`) is the ONE knob a project can set to opt a Tester observation's severity into blocking UAT's verdict. It is a manifest knob only — no Settings field. It is LIVE: `stages/uat.ts` threads it into `runUatTester` and turns a nonzero blocking count into a failed UAT verdict with a Tester-attributed recovery round (see `docs/arch/stages-and-gates.md`, "UAT Tester observations are advisory BY DEFAULT"). An absent `uat:` key, an absent `testerObservations:` key, and an absent `blockingSeverity:` all read as `'none'`, so every existing manifest and every manifest that omits the block keeps today's advisory-only Tester behavior byte-identically. Every read coalesces to `'none'`: the loader leaves the block undefined when absent but materializes `{ blockingSeverity: 'none' }` when it is present-but-empty.

## `diffsInSourceControl` reroutes the changes UI, never the diff itself

`diffsInSourceControl` (boolean, absent → off) decides only WHERE a ticket's changed-file list is listed: the "Ticket changes" webview panel (`TicketChangesManager`) or the `karst.diffs` section in the native Source Control view. The diff a click opens is the SAME code path either way — `openTicketDiff` → `vscode.diff` — so the flag can never produce a diff the other mode would not. The SCM path is vscode-free logic (`ui/diffs/treeController.ts` over the pure `ui/diffs/treeModel.ts`, adapted from `ui/diffs/scmModel.ts`); `extension/diffsHost.ts` binds `vscode.window.createTreeView` through the `DiffTreeProvider`/`makeDiffTreeHost` seam. The section leads with a ticket-selector row — a QuickPick of the project's active (non-`done`) tickets, scoped to `currentProject().id` and refusing to query when none is bound — and one tree of group / repository / commit / file nodes is rendered per shown ticket, rebuilt on show and on `karst.refreshDiffsTree`. Row actions reuse the diff targets: `karst.openTicketScmDiff` (Open Changes) and Open File on every file row, Unstage on staged rows, and Discard on unstaged/untracked rows. At most one tree is alive; showing a different ticket replaces its nodes, so stale rows from another ticket are unrepresentable.

## New `Manifest` field checklist

`service.healthIdentity` (opt-in, default off) is the one service field that changes what READY means — the service must echo `KARST_INSTANCE_TOKEN` back in `X-Karst-Instance` or it never becomes healthy; see `docs/arch/worktrees-and-servers.md`. The Settings toggle deletes the key rather than writing `false`, so an untouched service keeps a clean yml.

New `Manifest` field checklist: add to `types.ts` + `validateManifest` (schema.ts, default it) + **`writeManifest` overlay (write.ts)** or Save silently drops it. Guard: writeManifest.test.ts "round-trips every modeled section". Repository/service fields also go in `manifest/fixtures.ts` — the shared test builders every suite uses, so a shape change is one file, not 26.