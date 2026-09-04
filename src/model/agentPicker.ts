/**
 * The UNIFIED agent identity picker element (agent core + model + effort/variant).
 *
 * Every surface that asks a user to choose an agent — Settings-general (the
 * global default implementation agent), Settings-approaches graph profiles,
 * the ticket dashboard's agent switch, the ticket form's per-ticket pick —
 * renders the SAME component, delivered by marker injection exactly like
 * [[agentIdentity]]/[[designSystem]] (a self-contained webview cannot import
 * TS). One component, four hosts; a pick made anywhere looks and behaves the
 * same everywhere.
 *
 * The component is `mountAgentPicker(root, opts)`:
 *
 *   mountAgentPicker(root, {
 *     cores,            // [{id, label}] — implemented cores offered
 *     catalog,          // { provider: [ModelOption] } with model `efforts`
 *     recent,           // { provider: [modelId] } recently used, newest first (≤5)
 *     value,            // { core, model, effort } current selection
 *     inherit,          // { core?, model?, effort? } labels for "Inherit (settings: X)"
 *     disabled,         // lock the whole picker (session-open)
 *     showEffort,       // false = never render the effort/variant field
 *     onChange,         // ({ core, model, effort }) => void
 *   })
 *
 * `recent` feeds the model menu's "Last used" group (design § model UX): a
 * provider with a long catalog (opencode) buries a user's habitual pick, so the
 * models they actually used recently are pinned to the top of the list, newest
 * first, up to 5, rendered in the SAME group shape as the "saved" rows. Only
 * recent models still present in the catalog render — a recently used id that
 * left the catalog is not a dead option. The host computes the list from the
 * append-only `token_usage` ledger (`store/tokenUsage.ts`
 * `listRecentlyUsedModels`), so every surface that mounts the picker gets the
 * same "last used" group by passing the same shape.
 *
 * Effort is model-capability-aware (design § Execution policy resolution): the
 * effort/variant field renders ONLY when the selected model advertises efforts
 * in the LIVE catalog — an explicit effort for a model that advertises none is
 * a configuration error the host reports at Save, never something this field
 * silently offers. The field's options are exactly the model's advertised
 * efforts plus the inherit/none row. A saved effort that left the catalog stays
 * visible and selected so it is never silently rewritten.
 *
 * Model rows also render the model's advertised capability tags (`multimodal`,
 * `text-only`, `audio`, `vision`) as small chips under the model name, so a
 * user can tell at a glance what a model accepts. Tags may come from curated
 * catalog entries or be overlaid by `loadModelCatalog` for discovered models
 * whose id matches a curated entry; the picker renders whatever the host
 * supplies — there is no tag vocabulary in this file.
 *
 * CSS + JS live in the sibling `agentPicker.webview.css`/`agentPicker.webview.js`
 * source files — real CSS/JS a linter, formatter and editor can process,
 * instead of a TS template-literal string — and are read as plain text at
 * call time (same `readFileSync(join(RUNTIME_ASSETS_ROOT, …))` mechanism
 * `extension.ts` already uses for the `webview.html` documents;
 * `scripts/copy-assets.mjs` carries both files next to the compiled output),
 * then swapped into each webview's markers (`KARST_AGENT_PICKER_CSS` /
 * `KARST_AGENT_PICKER_JS`) before `injectCsp` nonces the document.
 * `agentPicker.webview.js` is never run through a bundler at webview-render
 * time — the runtime text lands verbatim in the document — and its
 * correctness is held by evaluating THAT FILE'S TEXT in
 * `agentPicker.test.ts`, never a TypeScript twin.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProvider } from '../manifest/types.js';
import type { ModelOption } from '../agent/modelCatalog.js';
import { RUNTIME_ASSETS_ROOT } from '../runtimeAssetsRoot.js';

/** Placeholder swapped for the picker CSS; sits inside each webview's `<style>`. */
export const AGENT_PICKER_CSS_MARKER = '/*KARST_AGENT_PICKER_CSS*/';

/** Placeholder swapped for the picker JS; sits inside each webview's `<script>`. */
export const AGENT_PICKER_JS_MARKER = '/*KARST_AGENT_PICKER_JS*/';

/** The model catalog shape the picker reads (mirrors `ModelCatalog`). */
export type AgentPickerCatalog = Readonly<
  Partial<Record<AgentProvider, readonly ModelOption[]>>
>;

/**
 * The `.ap-*` stylesheet for the unified picker. Self-contained so a surface
 * does not need its own picker CSS; sized with design tokens (UI-R04/R05).
 */
export function agentPickerCss(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'model/agentPicker.webview.css'), 'utf8').trim();
}

/**
 * The picker runtime. Emitted as plain statements (no wrapping `<script>` tag)
 * so it can be injected as the first lines of an existing block and picked up
 * by `injectCsp`'s nonce pass — the same contract as `agentIdentityJs`.
 */
export function agentPickerJs(): string {
  return readFileSync(join(RUNTIME_ASSETS_ROOT, 'model/agentPicker.webview.js'), 'utf8').trim();
}

/** Replace the picker CSS/JS markers; no-op per marker if absent. */
export function injectAgentPicker(html: string): string {
  return html
    .replace(AGENT_PICKER_CSS_MARKER, () => agentPickerCss())
    .replace(AGENT_PICKER_JS_MARKER, () => agentPickerJs());
}
