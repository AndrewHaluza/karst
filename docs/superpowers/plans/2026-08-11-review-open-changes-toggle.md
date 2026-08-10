# Review Changes-Panel Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make review's automatic opening of the ticket's Changes panel opt-in via a `review.openChanges` manifest setting (default OFF) with a Settings → Quality toggle that controls it.

**Architecture:** A new boolean manifest key `review.openChanges` (default `false`) is parsed by `validateReview`, honored by `runReview` (the ONLY place the changes surface opens — the host always wires `openDiff`, so the setting is the sole gate), and rendered/wired by the settings webview's Quality tab. The webview's `REVIEW_DEFAULTS` mirror is pinned to the validator by `webview.test.ts` (UI-R34), exactly like `requireIndependentSignal`.

**Tech Stack:** TypeScript (ESM), vitest, `node:sqlite` test stores, the existing settings webview (vanilla JS mirrored from TS modules).

## Global Constraints

- `review.openChanges` default is `false` — "by default off" is a hard requirement. Absent `review:` block, absent key, and `review: {}` all read OFF.
- No new settings section and no change to `SECTION_FIELDS`: `review` is already a whole-block Quality member; the new key rides the existing `updateReview` spread (never a `draft.review =` rebuild — the webview's Quality write contract).
- The webview cannot import TS: `REVIEW_DEFAULTS` in `webview.html` must stay byte-consistent with `validate/review.ts`; `webview.test.ts` pins the mirror.
- Every webview control must carry a matching `<label for>` (UI-R09).
- Strict TDD: write/update tests first, watch them fail, implement, watch them pass. Conventional commits.
- Run `npm run typecheck` after each task.
- Any path the plan touches lives in the worktree root (e.g. `karst.example.yml` is at repo root — verify with `ls karst.example.yml` before editing).
- The `scripts/copy-assets.mjs` step (`npm run build`) mirrors `karst.example.yml` and `karst.uat-review-setup.md` into `dist/` — never edit `dist/` copies directly.

---

### Task 1: Manifest model — `review.openChanges` key with default off

**Files:**
- Modify: `src/manifest/types.ts` — `ReviewConfig` (~line 326-332)
- Modify: `src/manifest/validate/review.ts` — `validateReview` (~line 89-127)
- Modify: `src/manifest/fixtures.ts` — `review()` builder (~line 115-124)
- Test: `src/manifest/load.test.ts` — `describe('review')` (~line 1288-1419)

**Interfaces:**
- Produces: `ReviewConfig.openChanges: boolean` (always set by `validateReview`, default `false`); `review()` fixture gains `openChanges: false`.
- Consumes: nothing.

- [ ] **Step 1: Update the existing "applies every default" test and add two new tests**

In `src/manifest/load.test.ts`, `describe('review')`:

Change the `toEqual` in "applies every default, including the findings lane ON at high severity" (currently line ~1302) to include `openChanges: false`:

```ts
      expect(loadManifest(path).review).toEqual({
        maxFixAttempts: 3,
        requireIndependentSignal: true,
        openChanges: false,
        findings: { enabled: true, blockingSeverity: 'high', maxFindings: 50 },
        repositories: {},
      });
```

Add, right after "refuses a non-boolean requireIndependentSignal" (ends ~line 1408):

```ts
  it('parses an explicit review.openChanges', () => {
    const yaml = `${VALID}\nreview:\n  openChanges: true\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(loadManifest(path).review!.openChanges).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('refuses a non-boolean review.openChanges', () => {
    const yaml = `${VALID}\nreview:\n  openChanges: "yes"\n`;
    const { path, cleanup } = fixture(yaml);
    try {
      expect(() => loadManifest(path)).toThrow(/review.openChanges/);
    } finally {
      cleanup();
    }
  });
```

- [ ] **Step 2: Run the review describe block to verify it fails**

Run: `npx vitest run src/manifest/load.test.ts -t review`
Expected: FAIL — the defaults test's `toEqual` mismatch names the missing `openChanges`, and `loadManifest(path).review!.openChanges` is `undefined` for the new tests.

- [ ] **Step 3: Add the field to the type**

In `src/manifest/types.ts`, inside `ReviewConfig` (after `requireIndependentSignal: boolean;`):

```ts
  /**
   * Whether review reveals the ticket's Changes panel when its gates finish.
   * DEFAULT OFF (this ticket): opening the panel used to be unconditional
   * whenever the host wired `openDiff`, so a review could surface a stack of
   * panels the user never asked for. The host ALWAYS wires `openDiff`; this
   * flag is the user's control over whether anything opens at all.
   */
  openChanges: boolean;
```

- [ ] **Step 4: Parse it in the validator**

In `src/manifest/validate/review.ts`, after the `requireIndependentSignal` parse block (ends ~line 114), add:

```ts
  let openChanges = false;
  if (raw.openChanges !== undefined) {
    if (typeof raw.openChanges !== 'boolean') {
      throw new ManifestError('review.openChanges must be a boolean');
    }
    openChanges = raw.openChanges;
  }
```

and add `openChanges,` to the `ReviewConfig` object literal in `validateReview` (between `requireIndependentSignal,` and `findings:`):

```ts
  const config: ReviewConfig = {
    maxFixAttempts,
    requireIndependentSignal,
    openChanges,
    findings: validateFindings(raw.findings),
    repositories: validateReviewRepositories(raw.repositories, repoNames),
  };
```

- [ ] **Step 5: Add it to the shared fixture**

In `src/manifest/fixtures.ts`, `review()` builder — insert between `requireIndependentSignal: true,` and `findings:`:

```ts
    openChanges: false,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/manifest/load.test.ts -t review`
Expected: PASS (all three).

- [ ] **Step 7: Run the whole manifest suite + typecheck**

Run: `npx vitest run src/manifest/ && npm run typecheck`
Expected: PASS. (`writeManifest.test.ts`'s "round-trips every modeled section" does not assert the review fixture's full shape — verify nothing else hard-codes the review block; `load.test.ts:1302` was the only exact `toEqual`.)

- [ ] **Step 8: Commit**

```bash
git add src/manifest/types.ts src/manifest/validate/review.ts src/manifest/fixtures.ts src/manifest/load.test.ts
git commit -m "feat(manifest): add review.openChanges setting, default off"
```

---

### Task 2: Review stage honors the toggle

**Files:**
- Modify: `src/workflow/stages/review.ts` — the `deps.openDiff` call site (~line 437-449) and the `OpenDiff`/`ReviewDeps.openDiff` doc comments (~line 47-55, 91-95)
- Test: `src/workflow/stages/review.test.ts` — the openDiff tests (~line 749-819)

**Interfaces:**
- Consumes: `Manifest.review.openChanges` (Task 1), `ReviewDeps.openDiff` (existing).
- Produces: nothing new — behavior change only: `openDiff` fires iff `deps.openDiff` is present AND `opts.manifest?.review?.openChanges === true` (absent manifest / absent key → `undefined` → OFF).

- [ ] **Step 1: Update the three existing tests that assert the surface opens, and add the OFF test**

`src/workflow/stages/review.test.ts` already imports `manifest` and `reviewConfig` from fixtures (line 18). The default `manifest({})` fixture carries NO `review` block, so after Task 2's gating those tests would read OFF. Supply `openChanges: true` in the three that assert opening:

"surfaces the changes of every target it reviewed, and records that as evidence" (~line 750): change its `manifest` option to

```ts
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig({ openChanges: true }) }) },
```

"records the changes evidence exactly once, however many targets opened it" (~line 780): same manifest replacement.

"opens the changes surface on a failing verdict too" (~line 804): it currently passes NO manifest; add one:

```ts
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}, { review: reviewConfig({ openChanges: true }) }) },
```

Add, right after "records no changes evidence when nothing was wired to open it" (ends ~line 801):

```ts
  // The host ALWAYS wires `openDiff`; the manifest setting is the only gate.
  // With the default (absent key → OFF), a wired host must not open anything
  // and must not claim it did in the evidence.
  it('does not open the changes surface while review.openChanges is off, even with a host wired to open it', async () => {
    await runReview(
      store,
      { ticketId: id, cwd: '/wt/web', artifactDir, manifest: manifest({}) },
      deps({
        planTargets: async () => ({
          kind: 'targets',
          targets: [{ repo: '/web', path: '/wt/web', names: ['web'] }],
        unmapped: [],
        }),
        openDiff,
      }),
    );
    expect(openDiff).not.toHaveBeenCalled();
    expect(listGateRuns(store, id).find((r) => r.gateName === 'changes')).toBeUndefined();
  });
```

- [ ] **Step 2: Run the review stage tests to verify they fail**

Run: `npx vitest run src/workflow/stages/review.test.ts`
Expected: FAIL — the three updated tests see `openDiff` not called; the new OFF test passes even before the implementation (it asserts the CURRENT unconditional behavior's absence only when off... actually it FAILS today because today `openDiff` IS called unconditionally — that is the RED for this task).

- [ ] **Step 3: Gate the call on the setting**

In `src/workflow/stages/review.ts`, replace the block at ~line 437-449:

```ts
    // The changes are worth seeing whatever the gates said, so this runs before
    // any verdict exists — for exactly the affected target set — but ONLY when
    // `review.openChanges` says so: the host always wires `openDiff`, so absent
    // the setting nothing opens (the toggle, default OFF, is the user's control
    // over whether review reveals the Changes panel at all).
    if (deps.openDiff && opts.manifest?.review?.openChanges) {
      deps.openDiff(opts.ticketId, target.path);
      // The changes surface is evidence exactly like a gate, recorded ONLY when
      // a real `openDiff` ran — and kept out of `entries` so it can never touch
      // the verdict, which stays the deterministic-gate computation it always
      // was. This is what persists "did the changes surface open" as evidence
      // that can be read back out of the store after a reload. Written once, on the first
      // target that opened one: it is one fact about the run, not one per repo.
      if (!diffOpened) evidence.append([{ gateName: 'changes', exitCode: 0 }]);
      diffOpened = true;
    }
```

Also update the `OpenDiff` type doc comment (add, after the existing sentences): "The host's wiring is not enough — `runReview` additionally requires `review.openChanges` (default OFF); without it the function is never called and no 'changes' evidence is recorded."

- [ ] **Step 4: Run the review stage tests to verify they pass**

Run: `npx vitest run src/workflow/stages/review.test.ts`
Expected: PASS — all four openDiff tests plus the unchanged suite.

- [ ] **Step 5: Run driveTicket + typecheck**

Run: `npx vitest run src/workflow/driveTicket.test.ts && npm run typecheck`
Expected: PASS — `driveTicket` only threads `openDiff` through; no change there.

- [ ] **Step 6: Commit**

```bash
git add src/workflow/stages/review.ts src/workflow/stages/review.test.ts
git commit -m "fix(review): only open the changes surface when review.openChanges is on"
```

---

### Task 3: Settings UI — Quality tab toggle

**Files:**
- Modify: `src/ui/settings/webview.html` — Quality tab markup (~line 855-867), `REVIEW_DEFAULTS` (~line 1219-1223), `renderQuality` (~line 3827-3839), the quality listeners (~line 3872-3883)
- Test: `src/ui/settings/webview.test.ts` — quality control list (~line 1430-1449), validator mirror regex (~line 1463), the three embedded `REVIEW_DEFAULTS` literals (~line 1479, 1551, 1964, 2025), the two hydration tests (~line 1514, 1526)

**Interfaces:**
- Consumes: `ReviewConfig.openChanges` (Task 1), the `updateReview` spread contract (existing).
- Produces: control `f-reviewOpenChanges` — hydrated from `review.openChanges ?? REVIEW_DEFAULTS.openChanges`, change event posts `updateReview({ openChanges: <checked> })`.

- [ ] **Step 1: Update the tests**

`src/ui/settings/webview.test.ts`:

1. In the quality-control id list (the `it(...).forEach` at ~line 1430-1449), add `'f-reviewOpenChanges',` after `'f-reviewIndependent',`.

2. In "mirrors the validators exactly" (~line 1463), extend the regex:

```ts
    expect(HTML).toMatch(
      /const REVIEW_DEFAULTS = \{\s*maxFixAttempts: 3,\s*requireIndependentSignal: true,\s*openChanges: false,\s*findings: \{ enabled: true, blockingSeverity: 'high', maxFindings: 50 \},\s*\};/,
    );
```

3. Add `openChanges: false,` after `requireIndependentSignal: true,` in ALL FOUR embedded `REVIEW_DEFAULTS` literals the file builds for `runInNewContext`: `runRenderQuality` (~line 1479), the severity-select test (~line 1551), `simulateQualityEdit` (~line 1964), and the `updateFindings` test (~line 2025).

4. In "renders review findings defaults as blocking when the block is absent" (~line 1514-1524), add:

```ts
    expect(field(result, 'f-reviewOpenChanges').checked).toBe(false);
```

5. In "hydrates from explicit values when the blocks are present" (~line 1526-1541), add `openChanges: true,` to the `review` draft object and:

```ts
    expect(field(result, 'f-reviewOpenChanges').checked).toBe(true);
```

- [ ] **Step 2: Run the settings webview tests to verify they fail**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: FAIL — the mirror regex and the id list do not match, and `renderQuality` never touches `f-reviewOpenChanges` (the `field()` helper throws "renderQuality never touched f-reviewOpenChanges").

- [ ] **Step 3: Add the checkbox markup**

In `src/ui/settings/webview.html`, Quality tab, Review card — right after the "Require independent signal" toggle + hint (line ~859), before the Agent findings toggle:

```html
          <div class="toggle" style="margin-top:10px">
            <input type="checkbox" id="f-reviewOpenChanges" />
            <label for="f-reviewOpenChanges">Open changes panel after review</label>
          </div>
          <div class="field-hint">Off by default. When on, a finished review reveals the
            ticket's Changes panel for every affected repository.</div>
```

- [ ] **Step 4: Mirror the default in REVIEW_DEFAULTS**

In `webview.html`'s `REVIEW_DEFAULTS` (~line 1219), insert between `requireIndependentSignal: true,` and `findings:`:

```js
    openChanges: false,
```

- [ ] **Step 5: Hydrate + wire the control**

In `renderQuality` (~line 3833-3835), after the `f-reviewIndependent` lines:

```js
    el('f-reviewOpenChanges').checked = review.openChanges != null
      ? Boolean(review.openChanges)
      : REVIEW_DEFAULTS.openChanges;
```

After the `f-reviewIndependent` change listener (~line 3872-3874):

```js
  el('f-reviewOpenChanges').addEventListener('change', () => {
    updateReview({ openChanges: el('f-reviewOpenChanges').checked });
  });
```

- [ ] **Step 6: Run the settings webview tests to verify they pass**

Run: `npx vitest run src/ui/settings/webview.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS. (webview.html is not typechecked; this guards the test changes.)

```bash
git add src/ui/settings/webview.html src/ui/settings/webview.test.ts
git commit -m "feat(settings): add review.openChanges toggle to the Quality tab"
```

---

### Task 4: Docs and the example manifest

**Files:**
- Modify: `karst.example.yml` — `review:` block (~line 397-403)
- Modify: `karst.uat-review-setup.md` — §5.3 example (~line 257-269) and the §9 canonical config (~line 367-376)
- Modify: `docs/config-ui-coverage.md` — Covered table (~line 26) and §2 text (~line 79-83)
- Modify: `docs/glossary.md` — the `review` key list (~line 495)

- [ ] **Step 1: Document the key in the example manifest**

In `karst.example.yml`, `review:` block, after the `requireIndependentSignal` entry (~line 403):

```yaml
  # Whether a finished review reveals the ticket's Changes panel for every
  # affected repository. Off by default — the changes are one click away in
  # the panel either way.
  openChanges: false
```

- [ ] **Step 2: Document it in the setup guide**

In `karst.uat-review-setup.md` §5.3 example (line ~260):

```yaml
  requireIndependentSignal: true  # boolean, default true
  openChanges: false              # boolean, default false — auto-reveal the Changes panel
```

and in the §9.1 canonical config (line ~369):

```yaml
  requireIndependentSignal: true
  openChanges: false
```

- [ ] **Step 3: Update config-ui-coverage.md**

Line ~26, Covered table — insert `review.openChanges` into the review row:

```markdown
| `review.maxFixAttempts`, `review.requireIndependentSignal`, `review.openChanges`, `review.findings.{enabled,blockingSeverity,maxFindings}`, `review.gates`, `review.repositories.<n>.gates` | Quality |
```

§2 "review: block — fully covered" (~line 79-83):

```markdown
`maxFixAttempts`, `requireIndependentSignal`, `openChanges`, `gates[]`,
`findings.{enabled, blockingSeverity,maxFindings}`, `repositories.<n>.gates`
all moved to Covered (Quality tab). Nothing in `review:` remains a gap.
```

- [ ] **Step 4: Update glossary.md**

Line ~495, the `review` key list:

```markdown
- `review` — `maxFixAttempts`, `requireIndependentSignal`, `openChanges`, `gates`,
```

- [ ] **Step 5: Verify the docs load and the example round-trips**

Run: `npx vitest run src/manifest/load.test.ts && npx vitest run src/cli/` (the example manifest is loaded by some suites — if `karst.example.yml` is exercised anywhere, confirm it still parses). Then verify the assets copy path still works:

Run: `npm run build`
Expected: PASS — `scripts/copy-assets.mjs` mirrors `karst.example.yml` + `karst.uat-review-setup.md` into `dist/`.

- [ ] **Step 6: Full verification + commit**

Run: `npx vitest run src/manifest/ src/workflow/stages/review.test.ts src/ui/settings/webview.test.ts && npm run typecheck && npm run build`
Expected: all PASS.

```bash
git add karst.example.yml karst.uat-review-setup.md docs/config-ui-coverage.md docs/glossary.md
git commit -m "docs: document review.openChanges setting"
```

---

## Self-Review

**1. Spec coverage:**
- "by default off" → Task 1 (`openChanges = false` default in `validateReview`; absent key reads `undefined` → OFF at the call site), Task 2 (call gated on `opts.manifest?.review?.openChanges`).
- "settings UI toggler" → Task 3 (Quality tab checkbox, hydrated + wired through `updateReview`).
- "which controls manifest change" → Task 3's `updateReview` posts into `draft.review`, saved by the existing tab-scoped Save → `writeManifest` (overlay already carries `review` wholesale, `write.ts:177` — no overlay change needed).
- Evidence honesty preserved: 'changes' gate row still only recorded when the surface actually opened (Task 2 keeps the `diffOpened` latch behind the same condition).

**2. Placeholder scan:** every step carries concrete code or an exact command; no TBDs.

**3. Type consistency:** `openChanges` is named identically in `ReviewConfig` (Task 1), `validateReview` (Task 1), the fixture (Task 1), the `review.ts` gate (Task 2), and the webview control/`REVIEW_DEFAULTS` (Task 3). The `field()`/`runRenderQuality` test helpers already exist — Task 3 only extends their embedded literals. `reviewConfig`/`manifest` fixture imports already exist in `review.test.ts` (line 18) and `buildReview` exists in `webview.test.ts` (unused here — Task 3 uses plain draft literals, matching the existing hydration tests).
