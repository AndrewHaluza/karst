# The manifest (`karst.yml`) and the Settings panel

What the manifest models, and the rules that keep a Settings write from silently reverting another tab. Related: `docs/arch/worktrees-and-servers.md` (the conventions block), `docs/arch/agent-cores.md` (the profile body an assignment resolves to).

## Contents

- A Settings process-assignment profile IS the process's prompt
- Settings Save is TAB-SCOPED
- A REPOSITORY is the primary entity; a SERVICE is an optional relation
- Legacy services: manifests migrate IN MEMORY
- New Manifest field checklist

## A Settings process-assignment profile IS the process's prompt

`processes.<key>.agent` names a profile from the agent POOL (a file agent or an approach artifact), and the profile's BODY — its custom prompt — is resolved at the execution boundary (`processFor` in `extension.ts`, through `soloAgentBody`, the SAME resolver the single-subagent launch path uses) and overlaid as the assignment's `instructions`, replacing the built-in role/strategy block. The profile body is the ONLY prompt source: the inline `processes.<key>.instructions` override (and its Settings textarea) is RETIRED, because two ways to say the same thing let a line in the yml silently outrank the profile the row was showing. No profile / an unreadable one → the built-in prompt. The retired key still LOADS (`inertKeys.ts` reports it as retired and names the replacement) and is simply dropped — never an error. `PROMPT_BEARING_ROLES` lives in `manifest/validate/processAssignments.ts` beside the role vocabulary; `webview.test.ts` pins the mirror. Wiring status: the profile body reaches the prompt-BEARING roles — `ticket-analysis`, `uatTester`, `review`. The interactive Fix roles (`uatFix`/`reviewFix`) and `prDescription` consume only the profile's provider/model/name snapshot. The ticket's own `single-subagent` approach+agent drives the SESSION, never the headless analysis.

## Settings Save is TAB-SCOPED, and the tab's fields are the whole write

`ui/settings/sections.ts` owns the split (`SECTION_FIELDS`, one section per manifest key; `mergeSection` overlays just that section) and `actions.ts`'s `save` merges the posted draft onto the manifest **as it is on disk right now**, then validates the MERGED result — so validity is judged on exactly what would reach the file. An unknown `section` on the message is DROPPED, never downgraded to a whole-manifest save — widening the write is the thing being prevented. `id`/`uat` belong to no section and always survive from the base. The webview mirrors `SECTION_FIELDS`/`SECTION_LABELS` (it cannot import TS) and `webview.test.ts` runs its `overlaySections` against the host's `mergeSection`; it also validates the per-tab CANDIDATE rather than the raw draft, so an unfinished edit parked on another tab cannot block this one. Leaving a dirty tab opens the page-local confirm (`requestSection`). A ManifestError arrives as `message`, i.e. prefixed `Invalid karst.yml…`; strip it once via `manifestFaultDetail` before any pattern match.

## A REPOSITORY is the primary entity; a SERVICE is an optional relation on it

`karst.yml` has `repositories:`; `start`/`health`/`ports`/`dependsOn` live under an optional `service:` block, so "port without a runnable process" is unrepresentable. `repoPath`/`hasMigrations`/`signals` stay repository-level — they describe the source tree and stay true whether or not anything runs. Gate on runnability ONLY via `manifest/runnable.ts` (`isRunnable` is a type guard, so `service` needs no `!`); scattering `?.` at call sites is how `svc.ports[0]!` used to throw. Non-runnable repos ARE scoped, DO get a worktree, and are absent from `ResolveResult.services`/`startOrder` — `ResolveResult.nonRunnable` names them so consumers state it rather than infer it from an absence.

## Legacy `services:` manifests migrate IN MEMORY

Legacy `services:` manifests migrate IN MEMORY (`manifest/migrate.ts`) + warn; `writeManifest`/`writeRepoSignals` upgrade the file on the next explicit save. Loading never writes (js-yaml drops comments). A file with BOTH keys is refused, never guessed. `ManifestError.withPath` attaches the file — validators only know field names, and a user may have several manifests.

## New `Manifest` field checklist

New `Manifest` field checklist: add to `types.ts` + `validateManifest` (schema.ts, default it) + **`writeManifest` overlay (write.ts)** or Save silently drops it. Guard: writeManifest.test.ts "round-trips every modeled section". Repository/service fields also go in `manifest/fixtures.ts` — the shared test builders every suite uses, so a shape change is one file, not 26.