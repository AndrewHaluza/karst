# Settings > Approaches Install/Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install and Uninstall buttons on an approach roster row send `install-approach` / `uninstall-approach`, show busy, block repeats, settle from the host receipt, and show failure on the row.

**Architecture:** New React component `ApproachInstallActions` owns two `useHostMutation`s (UI-R11) settled from `state.receipts`, plus an inline two-step Uninstall confirm. Host `installApproach`/`uninstallApproach` in `actions.ts` rethrow after posting `error`, so `reportAction` emits an `ok:false` receipt (today they swallow, so every receipt is `ok:true`).

**Tech Stack:** React, vitest + testing-library (jsdom), TypeScript ESM.

**Spec:** ticket FIX-SETTINGS-APPROACHES-INSTALL (D297); `docs/arch/approaches.md` APP-04/05/10.

## Global Constraints

- ESM imports end in `.js`; `noUncheckedIndexedAccess` on.
- Keep `data-karst-action="uninstall-approach"` on the Uninstall control and class `approach-install` on Install.
- Enable refusal "Install <id> before enabling it" unchanged.
- Out of scope: GitHub token, exec bit.
- Test files spawning no process / full-document render stay `*.test.*`.

---

### Task 1: Host receipts report failure

**Files:**
- Modify: `src/ui/settings/actions.ts` (`installApproach`, `uninstallApproach`)
- Test: `src/ui/settings/actions.test.ts`

**Interfaces:** Produces: both actions reject with the underlying error after posting `{type:'error'}`; an npm-confirm decline still resolves.

- [ ] Write failing tests: install with throwing `deps.installApproach` → `await expect(actions.installApproach('a')).rejects.toThrow('boom')` (still posts error and still reconciles); unknown id rejects `Unknown approach "nope".`; uninstall with throwing dep rejects.
- [ ] Run `npx vitest run src/ui/settings/actions.test.ts` → FAIL.
- [ ] Implement: keep the `ctx.post` calls, remember the first error, throw it after the reconcile/push step.
- [ ] Run again → PASS. Commit `fix: settings install/uninstall report failure in the action receipt`.

### Task 2: Row component

**Files:**
- Create: `src/ui/settings/app/sections/ApproachInstallActions.tsx`
- Modify: `src/ui/settings/app/sections/ApproachesSection.tsx` (replace the Install/Uninstall JSX)
- Test: `src/ui/settings/app/sections/ApproachesSection.test.tsx`

**Interfaces:** Produces `ApproachInstallActions({ id, installed, sourced })`.

- [ ] Failing tests (BASE has sourced `remote`, installed `tdd` via `mount(BASE, ['tdd'])`): Install click posts one `install-approach` `{id:'remote'}` with a requestId; button `aria-busy`; second click posts nothing; failure receipt shows alert text on that row only and re-enables Install; success receipt + state push with `installedIds:['remote']` shows Uninstall. Uninstall click posts nothing and shows Confirm/Cancel; Cancel posts nothing; Confirm posts `uninstall-approach`, busy, repeat no-op, failure shows message. Another row's button not busy.
- [ ] Run → FAIL.
- [ ] Implement component (below), wire into card.
- [ ] Run file → PASS; `npx vitest related` the touched files; `npm run -s typecheck`; `npm run -s lint:react`.
- [ ] Commit `fix: wire Settings approach Install/Uninstall buttons`.

```tsx
export function ApproachInstallActions({ id, installed, sourced }: Props) {
  const { state, send } = useSettingsApp();
  const install = useHostMutation<[]>({ kind: `Install ${id}`, send: (r) => send.installApproach(id, r) });
  const uninstall = useHostMutation<[]>({ kind: `Uninstall ${id}`, send: (r) => send.uninstallApproach(id, r) });
  const [confirming, setConfirming] = useState(false);
  // settle each mutation once per receipt (same pattern as the graph prompt link)
  ...
}
```

### Task 3: Verify

- [ ] `npm run -s typecheck`, `npm run -s lint:react`, full `npm run -s test:unit` once, `npm run -s test:visual:docker 2>&1 | tail -40` (webview change).
- [ ] `npx stryker run --mutate src/ui/settings/actions.ts` if score-gated.
