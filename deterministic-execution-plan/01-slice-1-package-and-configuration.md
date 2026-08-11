# Slice 1 — Package and Configuration Foundation

**Entry gate:** none.
**Exit gate:** see "Slice verification" at the end.
**Ships:** the built-in approach package, its manifest configuration shape, the built-in overlay seam, catalog effort metadata, and VSIX parity — with the approach **`enabled: false`**, invisible to the picker, the analyzer, and launch resolution (Decision 31). No runtime executes anything in this slice, by design: a ticket must not be able to select an approach whose runtime does not exist yet.

## Task 1 — Package the built-in approach and prove VSIX parity

**Why:** the approach must ship in the extension with the same bytes reviewers see in Git; a shipped package that is gitignored or untracked is unreviewable.

**Files:**
- `.agents/skills/karst-graph-engineering/SKILL.md` (new — approach entry descriptor)
- `.agents/skills/karst-graph-engineering/skills/graph-planner/SKILL.md` (new — planner prompt)
- `.agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md` (new — node base prompt)
- `scripts/copy-assets.mjs` (extend)
- `src/approaches/builtIn.ts` (new — packaged definition + package path resolution, no fs at module load)
- `src/approaches/builtIn.test.ts`, `src/approaches/packageParity.test.ts` (new)

**Changes:**
1. Author the three prompt files. The planner prompt states the generated-graph contract in the terms the compiler actually enforces — and **must not** describe a capability that does not exist: gate predicates see visit counts, outcome counts, expert-run counts, and artifact existence only, never exit codes, failing repository, or artifact content.
2. `builtIn.ts` exports `BUILT_IN_APPROACHES: readonly ApproachDef[]` containing exactly one entry: id `karst-graph-engineering`, label `Graph Engineering`, `recommended: false`, `enabled: false`, `source: undefined`, and the packaged `graph:` block from the design's Configuration Model (planner profile `expert`, profiles `expert`/`worker`/`fast`, **no** packaged `commands`, limits `confirmGeneratedGraph: true`, `maxParallel: 1`, `maxNodeRuns: 40`, `maxExpertRuns: 5`, `maxReplans: 2`, `maxActivations: 200`, and the wall-time/byte ceilings).
3. `copy-assets.mjs` copies `.agents/skills/karst-graph-engineering/**` into `dist/` preserving structure.
4. Parity test walks the packaged source directory and asserts every file is **tracked in Git** (`git ls-files`), not merely unignored — `.karst-plugin/` is gitignored today while its files are tracked, so an "unignored" criterion fails on the current tree (roadmap, Verified current state).
5. `karst-two-phase` retirement: `git ls-files | grep two-phase` returns empty on the current tree, so the obligation is already satisfied. Record it in the test as an assertion that no `karst-two-phase` path is tracked, and do not stop looking for a file that does not exist.

**Tests (RED first):**
- `builtIn.test.ts`: the packaged definition has `enabled: false`, `recommended: false`, no `source`, and no `commands` key; its `limits` equal the design's packaged defaults exactly (a table-driven equality, so a drifted default fails).
- `packageParity.test.ts`: every file under the package root is tracked; the entry descriptor and both prompt files exist; no tracked path matches `karst-two-phase`.

**Verification:** `npx vitest run src/approaches/builtIn.test.ts src/approaches/packageParity.test.ts`; `npm run build && ls dist/.agents/skills/karst-graph-engineering`.

**Done when:** the package exists, is tracked, is copied into `dist/`, and the packaged definition equals the design's defaults field-for-field.

## Task 2 — Extend the manifest pipeline for the nested `graph:` block

**Why:** `validateApproaches` (`src/manifest/schema.ts:89`) constructs a fresh object and drops unknown keys. Without this task the first load→save cycle **destroys** every graph field a user wrote. This is the "silent config loss" class.

**Files:** `src/manifest/types.ts`, `src/manifest/schema.ts`, `src/manifest/fixtures.ts`, `src/manifest/writeManifest.test.ts`, `src/manifest/load.test.ts`, `src/manifest/graphConfig.ts` (new — the validator for the block), `src/manifest/graphConfig.test.ts` (new).

**Changes:**
1. `types.ts`: `ApproachDef` gains exactly one optional key, `graph?: GraphApproachConfig`. `GraphApproachConfig` holds `planner`, `profiles`, `commands`, `limits` — **not hoisted** (Decision 4), so `SECTION_FIELDS.approaches` stays `['approaches']`.
2. `graphConfig.ts`: a pure validator that defaults every absent field, rejects unknown keys, and enforces closed vocabularies — `cwd: 'repository' | 'worktreeRoot'`, `access: 'read' | 'write'`, `timeoutSeconds` a finite safe integer in `1..7200`, `env` a bounded map of `NAME: value` strings. Every numeric limit is a finite safe integer inside its explicit inclusive range; fractions, negatives, `NaN`, and overflow are rejected, never coerced.
3. Product hard ceilings are enforced here, at manifest validation: `maxParallel <= 8`, `maxNodeRuns <= 200`, `maxExpertRuns <= 10`, `maxReplans <= 5`, `maxActivations <= 1000`, graph lifetime `<= 72h`, planner/agent wall time `<= 8h`, idle `<= 2h`, command timeout `<= 2h`, repositories per command `<= 20`, per-artifact `<= 100 MiB`, per-log `<= 10 MiB`, aggregate artifacts `<= 1 GiB`, aggregate workspace bytes `<= 100 GiB`. Configuration cannot raise a hard ceiling.
4. `maxExpertRuns < maxReplans + 1` is a **named manifest validation error**, not a compile-time surprise.
5. A file carrying both an old flat shape and the nested `graph:` block is **refused**, never guessed — mirroring the existing `services:`/`repositories:` both-keys refusal.
6. `write.ts` needs **no** new overlay entry: the `approaches` overlay passes the validated array through whole (design, Manifest pipeline obligations). Adding one would be a defect. Assert this with the round-trip test rather than by adding code.
7. `fixtures.ts` gains the block in the shared builders.

**Tests (RED first):**
- Round-trip: a full `graph:` block survives load → save → load byte-identically (`writeManifest.test.ts`, extending the existing "round-trips every modeled section" guard).
- Every closed vocabulary rejects an out-of-set value with a named message; every numeric field rejects `1.5`, `-1`, `NaN`, `Number.MAX_SAFE_INTEGER + 1`, and a string.
- Each hard ceiling rejects ceiling+1 and accepts ceiling.
- `maxExpertRuns: 2, maxReplans: 2` fails load with the named message.
- Both-shapes file is refused.
- A `graph:` block on a non-built-in approach id validates and is inert.

**Verification:** `npx vitest run src/manifest`; `npm run typecheck`.

**Done when:** a graph block survives the pipeline and every out-of-range value is refused at load.

## Task 3 — `withBuiltInApproaches` overlay seam

**Why:** two current facts make the seam necessary: `setApproachEnabled` errors `Unknown approach "<id>"` for an id absent from `manifest.approaches` (`src/ui/settings/actions.ts:330-336`) and `syncApproachEnabled` returns early for the same reason. Without the overlay, enabling or syncing the built-in silently no-ops.

**Files:** `src/approaches/withBuiltInApproaches.ts` + test (new); `src/extension.ts` (wire at the manifest-load seam and at `listInstalledApproachIds`, `extension.ts:1301`); `src/ui/ticketForm/state.ts`; `src/ui/settings/actions.ts`.

**Changes:**
1. `withBuiltInApproaches(manifest: Manifest): Manifest` — pure, no fs, no vscode. Overlays packaged built-ins onto `manifest.approaches` **by id**, field-by-field; a project entry wins per field and no project field is discarded. Two entries are never merged positionally.
2. Exactly three consumers: ticket form state, Settings actions, launch resolution. A second resolution path for any consumer is a defect — pinned by a test that greps the module graph for direct `BUILT_IN_APPROACHES` imports outside the seam.
3. `listInstalledApproachIds()` includes every **enabled** built-in id. Note the precise current behavior, verified in the ledger: `toApproachRows`' filter is `source === undefined || installedIds.has(id)` and `setApproachEnabled`'s install guard is `enabled && approach.source && !installed`, so a **sourceless** approach already passes both on the `source` term alone — it is offered and enableable without being "installed". The `listInstalledIds` change therefore exists for the *other* consumers of that list (Settings' installed-state rendering and `syncApproachEnabled`), not to unlock the guards. Re-enabling a tombstoned built-in must keep working precisely because the guard never applies to it; a task that "fixes" that by making the guard source-agnostic would make the built-in un-re-enableable.
4. Disable writes a small tombstone `{id, label, enabled: false}`; the registry-aware writer injects the packaged `label` because `validateApproaches` calls `requireString(a.label)` and a labelless tombstone **fails manifest load**. A tombstone for an id with no packaged definition and no prior entry is refused with a named error.
5. Settings Save serializes only the **delta** against the packaged definition — never the merged effective object, which would resurrect the whole built-in into the manifest (the stale-baseline clobber class). The webview mirrors the delta rule; `webview.test.ts` pins the mirror against the host (UI-R34).

**Tests (RED first):** absence → packaged defaults and enabled; project entry overlays field-by-field and discards nothing; tombstone round-trips and omits the id from `listInstalledIds`; labelless tombstone refused; packaged upgrade changes defaults without touching explicit project fields; each of the three consumers resolves the built-in through the seam and only through it; Save writes a delta, and a Save from a webview loaded before another tab's write does not revert it.

**Verification:** `npx vitest run src/approaches src/ui/settings src/ui/ticketForm`; `npm run typecheck`.

**Done when:** the built-in is enableable, disableable, and upgrade-safe through one seam.

## Task 4 — Selection behavior: analyzer gating, `defaultApproach` unchanged

**Why:** the built-in must never become a silent default, and analyzer output must never overwrite a user's pick.

**Files:** `src/ui/ticketForm/state.ts` (+ test), `src/ui/ticketForm/webview.html` if the flag needs mirroring, `src/ui/ticketForm/webview.test.ts`.

**Changes:**
1. Add host-side `pickerTouched: boolean` to ticket-form state. Set on any user interaction with the approach picker; never cleared within a form session.
2. The analyzer may call `setApproach` only when `!pickerTouched && ticket.approach === null`. After the picker is touched, later analysis is recommendation-only.
3. `defaultApproach`'s `recommended ?? approaches[0]` rule is **unchanged**; the built-in ships `recommended: false`. The existing `state.test.ts` default-selection assertions and `webview.test.ts` analyzer-badge assertions must pass **unmodified** — a diff to them is a defect, not a rebaseline.
4. A disabled built-in is absent from analyzer candidates and new-ticket choices; tickets already carrying it remain runnable.

**Tests (RED first):** analyzer sets the picker on a fresh form with no persisted choice; does not after a touch; does not when a persisted choice exists; re-enable preserves project overrides; two `recommended: true` built-ins are impossible (`validateApproaches` already throws, and packaged definitions carry `false`).

**Verification:** `npx vitest run src/ui/ticketForm`; confirm `git diff` shows **no** change to the pre-existing default-selection assertions.

## Task 5 — Catalog effort metadata and adapter effort capabilities

**Why:** the packaged Claude Opus `high` and Sonnet `low` defaults must validate against real capability metadata before the VSIX ships, or the built-in's own defaults are unverifiable.

**Files:** `src/agent/modelCatalog.ts`, `model-catalog.json`, `src/agent/modelCatalog.test.ts`, `src/agent/claude.ts`, `codex.ts`, `antigravity.ts`, `opencode.ts` (+ their tests), `src/agent/effort.ts` (new — pure resolution/validation), `src/agent/effort.test.ts`.

**Changes:**
1. `ModelOption` gains exactly one optional field: `efforts?: readonly string[]`. Mirror it into `model-catalog.json`; the existing "matches the published model feed exactly" test pins both copies — adding a model or an effort means editing both files.
2. A model with **no** `efforts` accepts **no** effort value. A custom user-typed model id is not in the catalog, so it accepts no effort — intended conservative behavior.
3. An explicitly configured effort the selected model does not advertise is a **configuration failure at Save**, never silently discarded.
4. Adapter bindings, per the design's table: Claude `--effort <value>`; Codex `--config model_reasoning_effort=<value>`; Agy `--effort <value>`; OpenCode `--variant <value>` where **effort is the model variant** — a profile setting both `model` and `effort` for OpenCode is rejected at Save with a named error. Interactive and headless capability declarations are separate; support in one never implies the other.
5. An adapter whose CLI exposes no effort flag renders no effort field at all.
6. Model and effort are individual argv values, never shell-interpolated.

**Tests (RED first):** catalog/feed equality including `efforts`; a model without `efforts` rejects any effort; OpenCode `model` + `effort` rejected at Save; each adapter translates one effort value into its exact flag form; packaged Opus `high` and Sonnet `low` validate; a feed entry supplying `efforts` for a model the bundled catalog lacks wins per existing precedence.

**Verification:** `npx vitest run src/agent`; `npm run typecheck`.

## Task 6 — Settings surface for the graph configuration

**Why:** the configuration is unusable if it is only a YAML shape, and every control in this repository has binding UI rules.

**Files:** `src/ui/settings/webview.html`, `src/ui/settings/actions.ts`, `src/ui/settings/sections.ts` (mirrors only), `src/ui/settings/webview.test.ts`.

**Changes:** add, inside the existing Approaches tab (no new section key, so `SECTION_FIELDS` is untouched): built-in enable/disable; planner profile + prompt link; profile provider/model/effort mappings; trusted command allowlist editor; a named **Budgets** subsection (graph lifetime, planner/agent wall time, idle time, command timeout, each showing packaged default and hard ceiling); artifact/workspace byte ceilings; concurrency and budget ceilings; generated-graph confirmation policy.

**UI rules that are pass/fail here** (`docs/ui/UI-RULES.md` v3.0): every control that posts to the host shows a pending state set locally on click, cannot be re-triggered, and reports a terminal outcome through the single `routeAction` seam with a mandatory watchdog whose timeout reports **unknown**, not failure (UI-R11–R14); `disabled` and `aria-busy` are distinct and disabling never uses `pointer-events:none` (UI-R17); pending feedback keeps geometry stable (UI-R18); actions are `<button>`, navigation is `<a href>` (UI-R09); icon-only controls carry accessible names (UI-R24); busy/result vocabularies are closed unions, never `string` (UI-R16); an agent core renders as canonical icon + canonical name with model/effort subordinate (UI-R10c) — a text-only `<select>` of core names does **not** conform; contrast verified per theme (UI-R29); the design system arrives by marker injection and the palette marker is carried (UI-R03); mirrored TS→HTML constants are behavior and their pinning tests must pass untouched (UI-R34).

**Tests (RED first):** saving a wall-time budget outside the hard ceiling is refused at Save; a per-tab Save writes only that tab's fields onto the on-disk manifest and validates the merged candidate; the webview's mirrored delta rule matches the host's; every new control has a pending state, an accessible name, and a closed result vocabulary.

**Verification:** `npx vitest run src/ui/settings`; visual check against `docs/ui/KARST-UI-CATALOG.html` in light, dark, and high-contrast.

## Task 7 — Prompt override identities

**Files:** `src/agent/settings.ts` (or the existing prompt-override resolution module), + tests.

**Changes:** register two stable editable prompt identities with precedence `project override → packaged prompt`:

| Settings agent id | Packaged path | Project override path |
|---|---|---|
| `karst-graph-planner` | `.agents/skills/karst-graph-engineering/skills/graph-planner/SKILL.md` | `<agentsDir>/karst-graph-engineering/graph-planner.md` |
| `karst-graph-node` | `.agents/skills/karst-graph-engineering/skills/graph-node/SKILL.md` | `<agentsDir>/karst-graph-engineering/graph-node.md` |

Editing writes only the project override; Reset deletes only that override and never mutates VSIX bytes; an extension upgrade replaces packaged bytes while preserving overrides. The override files are deliberately **tracked user content** inside the repository — no `KARST_EXCLUDE_RULES` entry is added for them, exactly as for existing agent prompt overrides.

**Tests (RED first):** override wins; reset restores packaged; upgrade preserves override; the packaged file is never written.

## Task 8 — Measurement baseline (Slice-1 half)

**Why:** the Slice-3 entry gate and the abandonment criterion are both unenforceable without a baseline captured before the runtime exists.

**Changes:** record, in `deterministic-execution-plan/measurement/baseline.md` (new), for N ≥ 5 recently completed real tickets run under the existing single-agent `impl`: implementation wall time, total token cost from `token_usage`, count of human interventions, and UAT-pass-on-first-attempt. Include the exact SQL used, so the post-Slice-3 measurement is the same query against the same columns.

**Verification:** the file exists, names its tickets and its queries, and its numbers are reproducible by re-running the recorded SQL.

## Slice verification

```bash
npm run typecheck
npm test
npm run build
git status --porcelain          # no stray files; dist/ is ignored
```

Expected:
- Full suite green, including every pre-existing test **unmodified** except where a task explicitly extends one (`writeManifest.test.ts`, `modelCatalog.test.ts`, settings/ticket-form webview mirrors).
- The built-in is present, `enabled: false`, absent from picker/analyzer/launch resolution.
- A user who enables it gets configuration surfaces and no execution — which is correct for this slice and is why the packaged default stays `false` until Slice 3.
- `99-INVARIANT-CHECKLIST.md` sections **A (configuration integrity)** and **F (UI conformance)** pass.
