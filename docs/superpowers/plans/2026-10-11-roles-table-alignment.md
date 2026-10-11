# Roles Table Alignment Implementation Plan


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Settings > Agents > Roles (`#agents/roles`) match the design reference: aligned columns at ≥1000px, labelled cards below, no mid-word breaks, Karst mark on Karst-supplied defaults.

**Architecture:** One shared 8-track grid (switch, Role, Profile, Core, Model, Effort, Source, Actions) drives header and rows. The picker cell spans 3 tracks and re-uses them through CSS subgrid. The shared picker gets a compact-only disabled "—" Effort placeholder and a full-id accessible name. Below 1000px the same DOM re-flows into cards by CSS only. A small `KarstMark` primitive (ICONS-05 exception) marks Karst-supplied values.

**Tech Stack:** React (Settings app, `src/ui/settings/app/**`), vanilla picker runtime (`src/model/agentPicker.webview.js`), plain CSS with `--k-*` tokens, vitest, Playwright visual (docker).

**Spec:** Design reference https://claude.ai/artifact/8d7fhSuGCqrhTZJhGUdiqN (binding per UI-R39; mockup colours, fonts and icons are stand-ins). Ticket intent/scenarios: `karst context UNTITLED-TICKET`. Rules: `docs/ui/UI-RULES.md` blocks `ui:UI-R35/R39/R41/R43/R44`; `docs/ui/ICONS.md` `ui:ICONS-05`.

## Global Constraints

- Tiers: wide ≥1000px, mid 700–999px, narrow ≤699px. `agents.webview.css` is pinned to these in `layoutBreakpoints.test.ts`; only use `@media (max-width: 999px)` and `(max-width: 699px)` there.
- Tokens only (`--k-*`, `--vscode-*`); no hex colours. Icons via `TablerIcon` (catalog names, e.g. `file-text`) — never hand-drawn SVG, except the Karst mark (ICONS-05).
- Labels never break mid-word: delete the `overflow-wrap:anywhere` / `white-space: normal` overrides added by 472ee4af (`agents.webview.css` lines ~212-225). Never add `overflow-wrap:anywhere` for ids.
- The page never scrolls sideways (UI-R43). No horizontal scroll container for the table.
- Out of scope: Model cell content (D111), toolbar and tokens (D110), focus and contrast (D109). Keep the current model label text.
- `compact` is used only by `RoleRows`; the effort placeholder must be gated on `compact` so other pickers still hide Effort.
- OpenCode core mark stays the rectangle (by design). Fix only its placement (same line as the name).
- Strict TDD, conventional commits, small files. Never edit visual baselines or the layout ledger by hand; use `npm run -s test:visual:docker:update` only when the user approves screenshots.
- **Rule conflicts → STOP AND ASK.** UI-R44 says "Ellipsis is for identifiers in fixed cells; long tokens use `overflow-wrap:anywhere`". The ticket decided: ellipsis + full id in title/accessible name, no `anywhere`. If VISUAL check (d) fails on this, or any other UI rule conflicts with a task below, stop and ask the ticket author. Do not edit rule text or weaken a gate on your own.
- **Ticket spec handoff:** the original ticket held a step-by-step CSS/edit/test spec that the charter dropped. This plan is derived from the code and the reference. If the author's spec is available (`karst context`, attachments), diff it against this plan before Task 1 and follow the spec where they disagree.

## File Structure

| File | Responsibility |
|---|---|
| `src/model/agentPicker.webview.js` | Pure helpers `apEffortMode`, `apModelTriggerName`; compact "—" placeholder; trigger title |
| `src/model/agentPicker.webview.css` | Placeholder look (dashed), `.ap-trigger` single-line ellipsis |
| `src/model/agentPicker.test.ts` | Tests for the two helpers + shipped-string pins |
| `src/ui/settings/app/primitives/KarstMark.tsx` (+ `.test.tsx`) | Inline Karst brand mark, `aria-hidden` |
| `src/ui/settings/app/sections/RoleRows.tsx` | Switch slot, field labels, file icon, Karst default marks, source text |
| `src/ui/settings/app/sections/RolesTab.tsx` | Header: empty "Enabled" first column, Core/Model/Effort separate |
| `src/ui/settings/agents.webview.css` | Grid, subgrid, fixed pin slot, cards, removed wrap overrides |
| `src/ui/settings/app/sections/AgentsSection.test.tsx` | Behaviour tests for rows and header |
| `docs/ui/ICONS.md` | One line added to `ui:ICONS-05` naming `KarstMark.tsx` |
| `tests/visual/**` | Run docker visual; baselines updated only with user approval |

Before editing any `docs/` block, read it with the awk extractor from CLAUDE.md and keep the `END_DOC_BLOCK` format.

---

### Task 1: Picker — compact "—" Effort placeholder and full-id name

**Files:**
- Modify: `src/model/agentPicker.webview.js` (renderEffort ~305-324, renderModel ~285-303, helpers near line 41)
- Modify: `src/model/agentPicker.webview.css`
- Test: `src/model/agentPicker.test.ts` (extend `load()` return list at ~line 27 with the two new helpers)

**Interfaces:**
- Produces (pure, in the shipped JS): `apEffortMode(efforts, saved, compact) -> 'select' | 'placeholder' | 'hidden'` and `apModelTriggerName(label, id, fallback) -> string`.

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe`, using the file's `load()`):

```ts
describe('compact effort placeholder', () => {
  const fns = load() as {
    apEffortMode: (e: string[] | undefined, saved: string, compact: boolean) => string;
    apModelTriggerName: (label: string, id: string, fallback: string) => string;
  };
  it('offers a select when the model advertises efforts', () => {
    expect(fns.apEffortMode(['low', 'high'], '', true)).toBe('select');
    expect(fns.apEffortMode(['low', 'high'], '', false)).toBe('select');
  });
  it('keeps a saved effort visible as a select', () => {
    expect(fns.apEffortMode(undefined, 'high', true)).toBe('select');
  });
  it('shows a disabled placeholder only in compact mode', () => {
    expect(fns.apEffortMode(undefined, '', true)).toBe('placeholder');
    expect(fns.apEffortMode([], '', true)).toBe('placeholder');
  });
  it('hides Effort outside compact mode as today', () => {
    expect(fns.apEffortMode(undefined, '', false)).toBe('hidden');
  });
  it('puts the full model id in the trigger name', () => {
    expect(fns.apModelTriggerName('deepseek-v4.1-flash', 'opencode-go/deepseek-v4.1-flash', 'No model'))
      .toBe('deepseek-v4.1-flash — opencode-go/deepseek-v4.1-flash');
    expect(fns.apModelTriggerName('', '', 'No model')).toBe('No model');
    expect(fns.apModelTriggerName('same', 'same', 'x')).toBe('same');
  });
  it('ships the placeholder markup and CSS', () => {
    expect(js).toContain('data-ap-effort-placeholder');
    expect(js).toContain('Effort is not available for this model');
    expect(agentPickerCss()).toContain('.ap-effort-placeholder');
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `npx vitest run src/model/agentPicker.test.ts`
Expected: FAIL — `apEffortMode is not a function` (and the new pins).

- [ ] **Step 3: Implement** in `agentPicker.webview.js`. Add the helpers beside `apEffortOptions`:

```js
/** How the Effort field presents: a select, a compact-only disabled "—", or nothing. */
function apEffortMode(efforts, saved, compact) {
  if ((efforts && efforts.length > 0) || saved) return 'select';
  return compact ? 'placeholder' : 'hidden';
}

/** Accessible name / tooltip of the model trigger: label plus the full id. */
function apModelTriggerName(label, id, fallback) {
  if (!label && !id) return fallback;
  if (!id || label === id) return label || id;
  return label + ' \u2014 ' + id;
}
```

In the root template (line ~260) add, directly after the `<select class="ap-effort" …>`:

```js
    + '<div class="ap-effort-placeholder" data-ap-effort-placeholder hidden role="group" aria-disabled="true"'
    + ' aria-label="' + apEsc(labelEffort) + ': Effort is not available for this model" title="Effort is not available for this model">\u2014</div>'
```

Replace `renderEffort` body so it uses the mode:

```js
  function renderEffort() {
    var field = $('[data-ap-effort-field]');
    var placeholder = $('[data-ap-effort-placeholder]');
    var sel = $('[data-ap-effort]');
    if (!showEffort) { field.hidden = true; return; }
    var efforts = apEfforts(catalog, state.core, state.model);
    var mode = apEffortMode(efforts, state.effort, compact);
    if (mode === 'select') {
      field.hidden = false; sel.hidden = false; placeholder.hidden = true;
      var effortInherit = labels().effort || (compact ? 'No effort' : '');
      var built = apEffortOptions(catalog, state.core, state.model, state.effort, effortInherit);
      sel.innerHTML = built.html || '<option value="" selected>' + apEsc(effortInherit || 'No effort (agent picks)') + '</option>';
    } else if (mode === 'placeholder') {
      field.hidden = false; sel.hidden = true; placeholder.hidden = false;
      state.effort = '';
    } else {
      field.hidden = true;
      state.effort = '';
    }
  }
```

(The previous inner `if (built.efforts === null && !state.effort)` branch is dead after this — `apEffortMode` returns `select` only when efforts exist or a value is saved, and `apEffortOptions` already returns the none row for a saved value. Delete it.)

In `renderModel` set the name on the model trigger after `modelTrigger.innerHTML = …`:

```js
    var triggerName = apModelTriggerName(coreLabel, state.model, labels().model || 'No model (agent picks)');
    modelTrigger.title = triggerName;
    modelTrigger.setAttribute('aria-label', labelModel + ': ' + triggerName);
```

Keep `aria-label` only when `compact` (non-compact triggers already have the visible `<label>`); wrap the `setAttribute` in `if (compact)`, keep `title` always.

In `agentPicker.webview.css` append:

```css
.ap-effort-placeholder{display:flex;align-items:center;justify-content:center;width:100%;min-height:var(--k-control-h-lg);box-sizing:border-box;
  color:var(--k-text-faint);border:var(--k-border-w) dashed var(--k-border);border-radius:var(--k-radius-sm);
  font-size:var(--k-text-md);cursor:default}
.ap-effort-placeholder[hidden]{display:none}
.ap-effort[hidden]{display:none}
```

Also pin `setDisabled` — the placeholder is not focusable, nothing to add.

- [ ] **Step 4: Run to verify PASS**

Run: `npx vitest run src/model/agentPicker.test.ts`
Expected: PASS. Then `npm run -s typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/model/agentPicker.webview.js src/model/agentPicker.webview.css src/model/agentPicker.test.ts
git commit -m "feat: compact picker shows a disabled Effort placeholder and the full model id in the trigger name (UI-R39, UI-R44)"
```

---

### Task 2: `KarstMark` primitive

**Files:**
- Create: `src/ui/settings/app/primitives/KarstMark.tsx`
- Test: `src/ui/settings/app/primitives/KarstMark.test.tsx`
- Modify: `docs/ui/ICONS.md` (`ui:ICONS-05`, item 1)

**Interfaces:**
- Produces: `KarstMark({ size?: number }): JSX.Element` — inline `<svg class="k-karst-mark" aria-hidden="true" focusable="false">`, default size 14. Task 3 and 4 import it as `import { KarstMark } from '../primitives/KarstMark.js'`.

- [ ] **Step 1: Failing test**

```tsx
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KarstMark } from './KarstMark.js';

describe('KarstMark', () => {
  it('is a decorative inline svg with the brand silhouette', () => {
    const { container } = render(<KarstMark />);
    const svg = container.querySelector('svg.k-karst-mark')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 215 215');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(svg.querySelector('circle')!.getAttribute('r')).toBe('26.5');
  });
  it('sizes the mark', () => {
    const { container } = render(<KarstMark size={12} />);
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('12');
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/ui/settings/app/primitives/KarstMark.test.tsx` — Expected FAIL (module missing).

- [ ] **Step 3: Implement** (path data is the dashboard's `KARST_MARK`, `src/ui/dashboard/webview.html:4428`):

```tsx
/**
 * The Karst brand mark, inline (ICONS-05 exception: an identity mark, not a
 * Tabler interaction icon). Marks values Karst supplies itself — the built-in
 * profile and the "default" source. Decorative: callers carry the text.
 */
export function KarstMark({ size = 14 }: { readonly size?: number }) {
  return (
    <svg className="k-karst-mark" viewBox="0 0 215 215" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M 96 20 L 25 67 L 25 156 L 98 203 L 98 180 L 44 145 L 44 78 L 97 44 Z" fill="currentColor" />
      <path d="M 151 42 L 138 58 L 170 78 L 170 144 L 138 165 L 150 180 L 188 156 L 188 67 Z" fill="currentColor" />
      <circle cx="106.5" cy="111.5" r="26.5" fill="currentColor" />
    </svg>
  );
}
```

Edit `docs/ui/ICONS.md` ICONS-05 item 1: append `, and the Settings Roles table's default marks (\`src/ui/settings/app/primitives/KarstMark.tsx\`)` before the final period of that item.

- [ ] **Step 4: Run** the test file — PASS. Run `npx vitest run src/ui/settings/app/architecture.test.ts` if it exists (`git ls-files | grep architecture.test`) to confirm no inline-SVG ban trips; if it bans `<svg` in `app/**`, add `KarstMark.tsx` to that test's documented exception list with the reason "ICONS-05".

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/app/primitives/KarstMark.tsx src/ui/settings/app/primitives/KarstMark.test.tsx docs/ui/ICONS.md
git commit -m "feat: KarstMark primitive for Karst-supplied values (ICONS-05)"
```

---

### Task 3: RoleRows and header markup

**Files:**
- Modify: `src/ui/settings/app/sections/RoleRows.tsx`
- Modify: `src/ui/settings/app/sections/RolesTab.tsx` (header block, lines ~150-166; pass names to `CompareRow`)
- Test: `src/ui/settings/app/sections/AgentsSection.test.tsx` (new `describe('Agents page — roles table layout markup')`)

**Interfaces:**
- Consumes: `KarstMark` (Task 2); picker placeholder (Task 1).
- Produces: row DOM contract used by Task 4 CSS. Each `RoleRow` has these direct children, in order, all `role="cell"`: `.agents-cell-switch`, `.agents-cell-role`, `.agents-cell-profile`, `.agents-cell-picker`, `.agents-cell-source`, `.agents-cell-actions`. Pin slot is `.agents-pin-slot`. Field labels are `.agents-field-label` (`aria-hidden`). Header has 8 `columnheader`s.

- [ ] **Step 1: Failing tests** (use the file's existing `mount`, `row`, `BASE`; `rowsWithoutSwitch` finds a non-pinnable role):

```tsx
describe('Agents page — roles table layout markup', () => {
  const cells = (r: Element) => Array.from(r.children).map((c) => c.className);

  it('header has an empty "Enabled" first column and Core / Model / Effort as separate headings', () => {
    mount();
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(heads).toEqual(['Enabled', 'Role', 'Agent profile', 'Core', 'Model', 'Effort', 'Source', 'Actions']);
    const first = screen.getAllByRole('columnheader')[0]!;
    expect(first.querySelector('.sr-only')!.textContent).toBe('Enabled');
  });

  it('every normal row has the same six cells in the same order', () => {
    mount();
    for (const r of document.querySelectorAll('.agents-row[data-role]')) {
      expect(cells(r).map((c) => c.split(' ').find((n) => n.startsWith('agents-cell-')))).toEqual([
        'agents-cell-switch', 'agents-cell-role', 'agents-cell-profile',
        'agents-cell-picker', 'agents-cell-source', 'agents-cell-actions',
      ]);
    }
  });

  it('a non-pinnable role has an empty switch cell and a hidden pin slot beside Clear', () => {
    mount();
    const r = Array.from(document.querySelectorAll('.agents-row[data-role]')).find(
      (el) => !el.querySelector('[role="switch"], input[type="checkbox"]'),
    )!;
    expect(r.querySelector('.agents-cell-switch')!.children).toHaveLength(0);
    const slot = r.querySelector('.agents-pin-slot')!;
    expect(slot.getAttribute('aria-hidden')).toBe('true');
    expect(slot.nextElementSibling!.getAttribute('aria-label')).toBe('Clear');
  });

  it('the profile open button uses the file icon and names the profile', () => {
    mount();
    const btn = screen.getAllByRole('button', { name: /^Open profile / })[0]!;
    expect(btn.querySelector('.icon-island')).not.toBeNull();
  });

  it('Karst defaults carry the mark, say "default", and never say "Role default"', () => {
    mount();
    expect(document.body.textContent).not.toContain('Role default');
    const r = row('implementation');
    const chip = r.querySelector('[data-source="default"]')!;
    expect(chip.querySelector('.k-karst-mark')).not.toBeNull();
    expect(chip.getAttribute('title')).toContain('Karst default');
    expect(chip.textContent).toContain('Karst default'); // screen-reader text
    expect(chip.querySelector('[aria-hidden="true"]:not(svg)')!.textContent).toBe('default'); // visible text
    expect(chip.getAttribute('title')).toContain("uses Karst's built-in default.");
  });

  it('a role on the built-in profile shows the mark and "Open Karst built-in …" labels', () => {
    mount();
    const btns = screen.getAllByRole('button', { name: /^Open Karst built-in (prompt|profile)$/ });
    expect(btns.length).toBeGreaterThan(0);
    expect(btns[0]!.querySelector('.k-karst-mark')).not.toBeNull();
    const sel = document.querySelector('.agents-profile-select.has-mark select') as HTMLSelectElement;
    expect(sel.selectedOptions[0]!.textContent).toBe('default');
    expect(sel.parentElement!.querySelector('.k-karst-mark')).not.toBeNull();
  });

  it('compare rows keep the empty switch cell and show A / B field labels', () => {
    // navigate to #agents/roles?compare=<other preset> exactly as the existing compare tests do
    mountCompare();
    const r = document.querySelector('.agents-compare-row')!;
    expect(r.firstElementChild!.className).toContain('agents-cell-switch');
    expect(Array.from(r.querySelectorAll('.agents-field-label')).map((l) => l.textContent?.slice(0, 2))).toEqual(['A:', 'B:']);
  });
});
```

`mountCompare` — copy the setup used by the existing `describe('Agents page — compare')` tests (lines ~169-190) into a local helper; do not invent a new route format.

- [ ] **Step 2: Run** `npx vitest run src/ui/settings/app/sections/AgentsSection.test.tsx` — Expected FAIL on the new tests only.

- [ ] **Step 3: Implement `RoleRows.tsx`.**

3a. Source text (replaces `SOURCE_TEXT`):

```tsx
export const SOURCE_TEXT: Readonly<Record<EffectiveRole['source'], { chip: string; label: string; why: string }>> = {
  pin: { chip: 'pinned', label: 'Pinned', why: 'Pinned: the same in all presets, and it beats the preset.' },
  preset: { chip: 'preset', label: 'Preset', why: 'From the selected preset.' },
  default: { chip: 'default', label: 'Karst default', why: "No preset value and no pin: uses Karst's built-in default." },
};
```

3b. `SourceCell` (new, in the same file):

```tsx
function SourceCell({ source }: { readonly source: EffectiveRole['source'] }) {
  const t = SOURCE_TEXT[source];
  if (source === 'default') {
    return (
      <span title={`${t.label}. ${t.why}`} data-source={source}>
        <Chip>
          <KarstMark size={12} />
          <span aria-hidden="true">{t.chip}</span>
          <span className="sr-only">{t.label}</span>
        </Chip>
      </span>
    );
  }
  return (
    <span title={t.why} data-source={source}>
      <Chip tone={source === 'pin' ? 'success' : 'neutral'}>{t.chip}</Chip>
    </span>
  );
}
```

3c. `ProfileCell`: option label `'default'` for `value: ''`; wrap the select so the mark can overlay; file icon; new open-button labels:

```tsx
  const builtIn = profile === '';
  return (
    <div className="agents-profile-cell">
      <span className="agents-field-label" aria-hidden="true">Agent profile</span>
      <div className="agents-profile-fields">
        <div className={`agents-profile-select${builtIn ? ' has-mark' : ''}`}>
          {builtIn ? <KarstMark /> : null}
          <Field … /* unchanged props, options[0] = { value: '', label: 'default' } */ />
        </div>
        <IconButton
          label={builtIn ? (promptBearing ? 'Open Karst built-in prompt' : 'Open Karst built-in profile') : `Open profile ${profile}`}
          onClick={() => onOpenProfile(builtIn ? null : profile)}
        >
          {builtIn ? <KarstMark /> : <TablerIcon name="file-text" />}
        </IconButton>
      </div>
    </div>
  );
```

For `key === undefined` (no-profile role) return `<span className="agents-muted">—</span>` as today but still inside the `.agents-cell-profile` cell.

3d. `RoleRow` body: replace the cell list with the six-cell contract:

```tsx
    <div className={classes} data-role={capability} role="row">
      <div className="agents-cell agents-cell-switch" role="cell">
        {pinnable ? <Switch … /> : null}
      </div>
      <div className="agents-cell agents-cell-role" role="cell">
        <span className="agents-role-name" title={label}>{label}</span>
      </div>
      <div className="agents-cell agents-cell-profile" role="cell"><ProfileCell {...props} /></div>
      <div className="agents-cell agents-cell-picker" role="cell"> …AgentPickerIsland unchanged… </div>
      <div className="agents-cell agents-cell-source" role="cell">
        <span className="agents-field-label" aria-hidden="true">Source</span>
        <SourceCell source={effective.source} />
      </div>
      <div className="agents-cell agents-cell-actions" role="cell">
        {pinnable ? (effective.source === 'pin' ? <Unpin/> : <Pin/>) : <span className="agents-pin-slot" aria-hidden="true" />}
        <IconButton label="Clear" … />
      </div>
    </div>
```

`.agents-pin-slot` is an empty span (same size as an icon button, styled in Task 4). `title={label}` on the role name gives the keyboard-unreachable-but-mouse tooltip only if truncated; role names are short — the cell wraps (Task 4), so keep `title` off if the name wraps. Decide in Task 4; default: no `title`.

3e. `CompareRow`: add props `aName: string`, `bName: string`; first child becomes `.agents-cell agents-cell-switch` (empty); role cell keeps the change dot; A and B cells each start with `<span className="agents-field-label" aria-hidden="true">A: {aName}</span>` / `B: {bName}`. In `RolesTab.tsx` pass `aName={preset ?? ''} bName={compare}`.

3f. `RolesTab.tsx` header:

```tsx
        <div className="agents-row agents-head" role="row">
          <div role="columnheader"><span className="sr-only">Enabled</span></div>
          <div role="columnheader">Role</div>
          {compare === null ? (
            <>
              <div role="columnheader">Agent profile</div>
              <div role="columnheader">Core</div>
              <div role="columnheader">Model</div>
              <div role="columnheader">Effort</div>
              <div role="columnheader">Source</div>
              <div role="columnheader">Actions</div>
            </>
          ) : ( …A / B / empty as today… )}
        </div>
```

3g. Fix the existing assertion in `AgentsSection.test.tsx` if any test queries the old `Core · Model · Effort` header text or `Open built-in …` labels (`grep -n "Core · Model\|Open built-in" src -r`).

- [ ] **Step 4: Run**

Run: `npx vitest run src/ui/settings/app/sections/AgentsSection.test.tsx src/ui/settings/app/primitives` then `npm run -s typecheck && npm run -s lint:react`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/app
git commit -m "feat: Roles rows use one cell contract; Karst marks, file icon, separate Core/Model/Effort headers (UI-R39, UI-R41)"
```

---

### Task 4: CSS — shared grid, subgrid picker, fixed slots, cards, no mid-word breaks

**Files:**
- Modify: `src/ui/settings/agents.webview.css`
- Modify: `src/model/agentPicker.webview.css` (only if `.ap-compact` needs the subgrid hook — prefer overriding from `agents.webview.css`)
- Test: `src/ui/layout/layoutBreakpoints.test.ts` (existing pin must stay green) and a new `src/ui/settings/agentsCss.test.ts`

**Interfaces:**
- Consumes: DOM contract from Task 3.

- [ ] **Step 1: Failing test** `src/ui/settings/agentsCss.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/ui/settings/agents.webview.css', 'utf8');

describe('agents.webview.css — roles table', () => {
  it('uses one 8-track template for header and rows', () => {
    expect(css).toContain('--agents-cols:');
    expect(css.match(/grid-template-columns:\s*var\(--agents-cols\)/g)!.length).toBeGreaterThanOrEqual(1);
  });
  it('re-uses the tracks for the picker via subgrid', () => {
    expect(css).toMatch(/\.agents-cell-picker[^{]*\{[^}]*grid-template-columns:\s*subgrid/);
  });
  it('never breaks words mid-word and drops the 472ee4af wrap overrides', () => {
    expect(css).not.toContain('overflow-wrap: anywhere');
    expect(css).not.toContain('overflow-wrap:anywhere');
    expect(css).not.toMatch(/\.ap-trigger-label[^{]*\{[^}]*white-space:\s*normal/);
    expect(css).not.toMatch(/\.k-chip\s*\{[^}]*white-space:\s*normal/);
  });
  it('truncates model labels with an ellipsis on one line', () => {
    expect(css).toMatch(/\.ap-trigger-label[^{]*\{[^}]*text-overflow:\s*ellipsis/);
  });
  it('hides field labels on wide rows and shows them on cards', () => {
    expect(css).toMatch(/\.agents-field-label\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/@media \(max-width: 999px\)[\s\S]*\.agents-field-label[^}]*display:\s*block/);
  });
  it('keeps the pin slot the size of an icon button', () => {
    expect(css).toMatch(/\.agents-pin-slot\s*\{[^}]*width:\s*var\(--k-hit-min\)/);
  });
  it('never scrolls the page sideways', () => {
    expect(css).not.toMatch(/\.agents-table\s*\{[^}]*overflow-x:\s*(auto|scroll)/);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/ui/settings/agentsCss.test.ts` — Expected FAIL.

- [ ] **Step 3: Implement.** In `agents.webview.css`:

(a) Replace the roles grid block (lines ~64-85) with:

```css
/* Roles table: ONE track template shared by header and rows (UI-R41). Tracks:
   switch | role | profile | core | model | effort | source | actions.
   The picker cell spans core+model+effort and re-uses those tracks via subgrid. */
#section-agents .agents-table {
  --agents-cols: 40px minmax(120px, 1.1fr) minmax(150px, 1fr) 150px minmax(170px, 1.3fr) 120px 92px 72px;
  display: flex;
  flex-direction: column;
  border: var(--k-border-w) solid var(--vscode-panel-border, var(--k-border));
  border-radius: var(--k-radius-md);
}

#section-agents .agents-row {
  display: grid;
  grid-template-columns: var(--agents-cols);
  column-gap: var(--k-space-2);
  align-items: center;
  min-height: 44px;
  padding: 0 var(--k-space-3);
  border-left: 3px solid transparent;
  border-top: var(--k-border-w) solid var(--vscode-panel-border, var(--k-border));
}

#section-agents .agents-compare-row,
#section-agents .agents-table .agents-head:has(+ .agents-compare-row) {
  grid-template-columns: 40px minmax(120px, 1.1fr) minmax(0, 1.4fr) minmax(0, 1.4fr) 150px;
}

#section-agents .agents-cell-picker {
  grid-column: span 3;
  display: grid;
  grid-template-columns: subgrid;
  column-gap: var(--k-space-2);
}
#section-agents .agents-cell-picker > .agent-picker-island { display: contents; }
#section-agents .agents-cell-picker .ap-compact {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  column-gap: var(--k-space-2);
}
#section-agents .agents-cell-source { justify-content: flex-start; }
#section-agents .agents-cell-actions { display: flex; justify-content: flex-end; gap: var(--k-space-1); }
#section-agents .agents-pin-slot { display: inline-block; width: var(--k-hit-min); height: var(--k-hit-min); flex: none; visibility: hidden; }
#section-agents .agents-field-label { display: none; font-size: var(--k-text-xs); color: var(--vscode-descriptionForeground); }
#section-agents .agents-cell-switch { justify-content: center; }
#section-agents .agents-role-name { font-weight: 500; overflow-wrap: break-word; }
```

(`overflow-wrap: break-word` only breaks a word that cannot fit on its own line; role names are short. If VISUAL check (d) objects, STOP AND ASK — see Global Constraints.)

(b) Remove the old `.agents-cell { flex-wrap: wrap }` rule's wrap behaviour for table cells: make `.agents-cell { min-width: 0; display: flex; align-items: center; gap: var(--k-space-1) var(--k-space-2); }` (no `flex-wrap`). Keep `.agents-cell-role`, drop its `flex-wrap`.

(c) Profile cell:

```css
#section-agents .agents-profile-cell { display: flex; flex-direction: column; gap: 2px; width: 100%; min-width: 0; }
#section-agents .agents-profile-fields { display: flex; align-items: center; gap: var(--k-space-1); min-width: 0; }
#section-agents .agents-profile-select { position: relative; flex: 1 1 auto; min-width: 0; }
#section-agents .agents-profile-select select { width: 100%; min-height: var(--k-control-h-lg); min-width: 0; text-overflow: ellipsis; }
#section-agents .agents-profile-select.has-mark select { padding-inline-start: calc(var(--k-space-3) + 14px + var(--k-space-1)); }
#section-agents .agents-profile-select.has-mark .k-karst-mark {
  position: absolute; inset-inline-start: var(--k-space-3); top: 50%; transform: translateY(-50%); pointer-events: none; color: var(--k-link);
}
#section-agents .k-karst-mark { flex: none; }
```

(d) Replace the "Targets and truncation" block's wrap overrides (current lines ~219-225) with:

```css
#section-agents .agents-item,
#section-agents .agents-tab,
#section-agents .k-btn--link,
#section-agents .k-switch { min-height: var(--k-hit-min); }
#section-agents .k-switch { min-width: var(--k-hit-min); }
/* Identifiers truncate on one line; the full id is in the trigger's title / accessible name (UI-R44). */
#section-agents .agents-cell-picker .ap-trigger-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
#section-agents .agents-cell-picker .agent-identity { flex-wrap: nowrap; }
#section-agents .agents-cell-picker .agent-identity-icon { flex: none; }
#section-agents .agents-cell-picker .agent-identity-name { white-space: nowrap; }
#section-agents .agents-cell-picker .agent-identity-model { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#section-agents .agents-muted { min-width: 0; }
```

Delete the `.k-chip { white-space: normal }` and `overflow-wrap: anywhere` lines. Delete the old `.agents-cell-picker > .agent-picker-island { flex: 1 1 100% }` rule and the `.ap-compact { grid-template-columns: minmax(0,1fr) }` line in the `max-width: 699px` block (the narrow tier is handled below).

(e) Tier blocks (keep only `999` and `699` widths):

```css
@media (max-width: 999px) {
  #section-agents .agents-head { display: none; }
  /* Card: top line = switch | name | source | actions, then Profile + Core/Model/Effort as 4 equal columns. */
  #section-agents .agents-row {
    grid-template-columns: repeat(12, minmax(0, 1fr));
    row-gap: var(--k-space-2);
    padding: var(--k-space-3);
  }
  #section-agents .agents-cell-switch  { grid-column: span 1; }
  #section-agents .agents-cell-role    { grid-column: span 5; }
  #section-agents .agents-cell-source  { grid-column: span 3; }
  #section-agents .agents-cell-actions { grid-column: span 3; }
  #section-agents .agents-cell-profile { grid-column: span 3; }
  #section-agents .agents-cell-picker  { grid-column: span 9; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  #section-agents .agents-cell-picker .ap-compact { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  #section-agents .agents-field-label { display: block; }
  #section-agents .agents-cell-picker .ap-compact .ap-label {
    position: static; width: auto; height: auto; overflow: visible; clip: auto; clip-path: none; white-space: normal;
  }
  #section-agents .agents-cell-source { flex-direction: row; }
  #section-agents .agents-cell-source .agents-field-label { display: none; }
  /* compare rows: switch | name, then A and B side by side, actions last */
  #section-agents .agents-compare-row .agents-cell-role { grid-column: span 11; }
  #section-agents .agents-compare-row > .agents-cell:not(.agents-cell-switch):not(.agents-cell-role):not(.agents-cell-actions) { grid-column: span 6; flex-direction: column; align-items: flex-start; }
  #section-agents .agents-compare-row .agents-cell-actions { grid-column: 1 / -1; justify-content: flex-start; }
}
@media (max-width: 699px) {
  #section-agents .agents-row { grid-template-columns: var(--k-hit-min) minmax(0, 1fr) auto auto; }
  #section-agents .agents-cell-switch { grid-column: 1; }
  #section-agents .agents-cell-role { grid-column: 2; }
  #section-agents .agents-cell-source { grid-column: 3; }
  #section-agents .agents-cell-actions { grid-column: 4; }
  #section-agents .agents-cell-profile,
  #section-agents .agents-cell-picker { grid-column: 1 / -1; }
  #section-agents .agents-cell-picker,
  #section-agents .agents-cell-picker .ap-compact { grid-template-columns: minmax(0, 1fr); }
  #section-agents .agents-compare-row .agents-cell-role { grid-column: 2 / -1; }
  #section-agents .agents-compare-row > .agents-cell:not(.agents-cell-switch):not(.agents-cell-role):not(.agents-cell-actions) { grid-column: 1 / -1; }
  #section-agents .agents-profiles { grid-template-columns: minmax(0, 1fr); }
  #section-agents .agents-profiles.has-selection .agents-list { display: none; }
  #section-agents .agents-profiles:not(.has-selection) .agents-detail { display: none; }
  #section-agents .agents-back { display: inline-flex; }
}
```

Put the `999` block BEFORE the `699` block so narrow wins. Remove the old duplicate `@media` blocks at the file end.

(f) Disabled rows keep `opacity`, but the `.is-inherited .agents-cell-picker { opacity: .65 }` stays. Selected/flash/shared rules are unchanged.

- [ ] **Step 4: Run**

Run: `npx vitest run src/ui/settings/agentsCss.test.ts src/ui/layout/layoutBreakpoints.test.ts` — PASS.
Then the docker visual gate (UI work is verified there, host `test:layout` is advisory): `npm run -s test:visual:docker 2>&1 | tail -40` and `npm run -s test:layout:docker 2>&1 | tail -40`. Read the agents screenshots at 1200 / 850 / 600px in light, dark and high-contrast. Check each scenario in the ticket (aligned columns, one-line ellipsis, no horizontal scroll, OpenCode icon inline, Effort "—" dashed, cards with visible labels, compare rows).
If layout check (d) flags clipped text, or any UI rule conflicts → **STOP AND ASK**; do not edit `layout-known-failures.json` or baselines.
Show the user the new screenshots; run `npm run -s test:visual:docker:update` only after they approve.

- [ ] **Step 5: Commit**

```bash
git add src/ui/settings/agents.webview.css src/ui/settings/agentsCss.test.ts
git commit -m "fix: Roles table aligns on one grid, truncates ids on one line, and flows into cards below 1000px (UI-R39, UI-R41, UI-R43, UI-R44)"
```

---

### Task 5: Verify, mutate, and close out

**Files:** none new.

- [ ] **Step 1: Cite the rules.** Make sure at least one commit body cites `UI-R35` for the rule-driven remediation (amend the Task 4 message body: "Remediates UI-R39 / UI-R41 / UI-R43 per UI-R35").

- [ ] **Step 2: Scoped tests** — `npx vitest related src/model/agentPicker.webview.js src/ui/settings/app/sections/RoleRows.tsx src/ui/settings/agents.webview.css` then fix failures by rerunning only the failing file.

- [ ] **Step 3: Mutation gate** — `src/model/agentPicker.ts` is not under `src/extension/**`, so Stryker does not gate this change. Confirm with `grep -n "mutate" stryker.config.json` and skip if so; do not add `mutate` excludes.

- [ ] **Step 4: Full suite once** — `npm run -s typecheck && npm run -s lint:react && npm run -s test:unit 2>&1 | tail -15 && npm run -s test:integration 2>&1 | tail -15`. `renderedAgents.render.integration.test.tsx` may pin header text or `Open built-in …` — update its expectations to the new strings only.

- [ ] **Step 5: Build** — `npm run -s build 2>&1 | tail -10` (`verify-build.mjs` must pass; `agents.webview.css` is already mirrored).

- [ ] **Step 6: Post one bulletin note** (optional): "Roles table: picker cell spans 3 tracks via subgrid; compact picker shows a disabled '—' Effort placeholder; KarstMark is an ICONS-05 exception." Then fire the stage marker: `stage` MCP tool `{ stage: "impl" }`.

---

## Self-Review

**Spec coverage** (ticket scenario → task): aligned columns / fixed controls → T3 cell contract + T4 grid; header Core/Model/Effort + visually empty "Enabled" → T3f; non-pinnable empty switch + blank aria-hidden pin slot → T3d + T4; long id ellipsis, no mid-word → T4(d); full id in accessible name and in menu by keyboard → T1 (`apModelTriggerName`; menu items already print the id in `.ap-model-sub`, unchanged); OpenCode icon inline → T4(d) (`.agent-identity` nowrap, mark untouched); no-effort "—" disabled, dashed, accessible name, compact-only → T1; effort select unchanged → T1 `select` mode; non-compact hidden → T1; file icon + "Open profile <name>" → T3c; Karst mark + "default", no "Role default" → T3c; open-button Karst mark + labels → T3c; Source chip mark + "default", "Karst default" tooltip/SR, no visible "Karst" → T3b; Source explanation text → T3a; 850px cards, top line + 4-col grid + visible labels, header hidden → T4(e); labels hidden at 1200 but SR-readable → T4 (`display:none` on `aria-hidden` duplicates; the select, picker `.ap-label` and `Field` labels carry the SR names); 600px stack, no sideways scroll → T4(e); compare row switch cell + A:/B: labels → T3e + T4(e); all-states matrix at 3 widths × 3 themes → T4 step 4 (docker visual).

**Placeholder scan:** none. One deliberate open point: the Source chip title for `default` is `"Karst default. No preset value and no pin: uses Karst's built-in default."` — it satisfies both scenarios by containing both strings. Confirm with the author if they want two separate surfaces.

**Type consistency:** `KarstMark({ size })` (T2) used as `<KarstMark />` / `<KarstMark size={12} />` (T3). `SOURCE_TEXT[...].label` added in T3a and read in T3b. CSS classes `agents-cell-switch|role|profile|picker|source|actions`, `agents-pin-slot`, `agents-field-label`, `agents-profile-select`, `has-mark`, `k-karst-mark` are the same in T3 markup, T3 tests and T4 CSS. Picker helpers `apEffortMode` / `apModelTriggerName` match between T1 tests and implementation.

**Known risks for the implementer:** (1) CSS subgrid needs Chromium ≥117 — VS Code 1.126 ships Electron 39, fine; the jsdom tests cannot see layout, so only the docker visual run proves alignment. (2) `Field`'s select may already wrap itself in a container — if the `.has-mark` overlay selector misses, adjust the wrapper class only, not the DOM contract. (3) The UI-R44 conflict above.
