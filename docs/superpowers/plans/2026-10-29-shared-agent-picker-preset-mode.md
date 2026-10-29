# Shared Agent Picker Preset Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `presetMode` to `mountAgentPicker` (Preset | Core + model segmented control) and enable it in the ticket form.

**Architecture:** All logic lives in the vanilla runtime `src/model/agentPicker.webview.js` (+ `.css`). With `presetMode` absent the markup, payload and CSS behavior stay byte-identical. The ticket form passes `presetMode`, drops its own preset select, and persists preset XOR core/model/effort from the `onChange` payload (`mode`).

**Tech Stack:** vanilla JS runtime, TS host wrappers, vitest (+ jsdom), Playwright visual variants.

**Spec:** ticket T839 prompt (SHARED-AGENT-PICKER-OPT-IN).

## Global Constraints

- `presetMode: { names: string[], selected: string|null, inheritLabel }`; off by default; off = byte-identical DOM and payload `{core, model, effort}`.
- Segmented control: labels `Preset` | `Core + model`, `role="radiogroup"`, buttons `role="radio"` + `aria-checked` (ui:UI-R26), shared `k-btn` primitives.
- Preset tab: one select (inheritLabel + names); core/model/effort fields HIDDEN (`hidden`), not disabled.
- Core tab: core (icon + name), model (existing catalog/routed stack), effort (existing visibility rule).
- Payload `mode: 'preset'|'core'` (closed union). Mode `preset` => core/model/effort `''`; mode `core` => preset `''`.
- Initial mode: `preset` when a preset is selected, else `core`.
- Missing preset: warning `Preset <name> not found`, value kept, no auto-switch/save.
- Ticket form: remove `or use a preset` select and `Overrides the core, model and effort above` hint; persist preset XOR trio; usage-limit `Pick agent/model…` forces core mode.
- Visual variants `agent-preset`, `agent-core-model` in `tests/visual/variants.ts`.

---

### Task 1: Runtime preset mode
**Files:** Modify `src/model/agentPicker.webview.js`, `src/model/agentPicker.webview.css`, `src/model/agentPicker.ts` (header doc). Test `src/model/agentPicker.test.ts`, `src/model/agentPicker.dom.test.ts`.
**Produces:** option `presetMode`; instance method `setMode('preset'|'core')`; payload `{mode, preset, core, model, effort}` when on.
- [ ] Write failing DOM tests (toggle, hidden fields, payload clearing, missing preset, effort visibility, off = unchanged payload).
- [ ] Run: `npx vitest run src/model/agentPicker.dom.test.ts` — FAIL.
- [ ] Implement runtime + CSS.
- [ ] Run again plus `agentPicker.test.ts` — PASS.
- [ ] Commit.

### Task 2: Ticket form wiring
**Files:** Modify `src/ui/ticketForm/webview.html`. Test `src/ui/ticketForm/webview.test.ts`, `state.test.ts`, `actions.test.ts`.
**Consumes:** Task 1 option + payload.
- [ ] Failing tests: html has no `agentPresetSelect`/hint; passes `presetMode`; onChange handles `mode`; actions persist preset XOR trio.
- [ ] Implement; run files; commit.

### Task 3: Visual variants + docs
**Files:** Modify `tests/visual/variants.ts`; check `docs/ui` mentions.
- [ ] Add `agent-preset`, `agent-core-model` variants; run typecheck; commit.

### Task 4: Gates
- [ ] `npm run -s typecheck`, `npm run -s lint:react`, related tests, mutation on changed `src/extension/**` (none expected), final full unit run.
