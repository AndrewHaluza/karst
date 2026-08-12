/**
 * Agent-core brand identity — single source of truth for how an `AgentProvider`
 * renders across webviews: the canonical provider SVG icon, the provider name,
 * and (in the full identity) the selected model.
 *
 * The identity pattern is ONE shape everywhere: `[icon] Provider · Model`
 * (e.g. `[C] Claude Code · Opus 4.1`). Adding a provider means registering ONE
 * metadata row here and dropping ONE icon asset into `model/icons/agent/` — the
 * renderers and CSS never change.
 *
 * The canonical icon assets are the Lobe Icons SVGs (claude-code.svg,
 * codex.svg, antigravity-cli.svg, opencode.svg — see the package SOURCES.txt;
 * MIT, brand marks remain their owners'). They ship next to this module:
 * `src/model/icons/agent/` under vitest, `dist/model/icons/agent/` at runtime
 * (`scripts/copy-assets.mjs` mirrors them), read via `import.meta.url` so the
 * same loader works in both places. A missing asset (a packaging regression)
 * degrades to the label-only badge — an icon hole is never rendered.
 *
 * Theme support: the Claude/Codex/OpenCode marks are `fill="currentColor"`, so
 * they inherit the surrounding text color in light and dark alike; the
 * Antigravity mark is a fixed brand-color logo and renders as its brand in
 * both themes (same precedent as the ClickUp gradient in [[providerIdentity]]).
 * Width/height attributes are stripped at load so CSS alone controls size —
 * one sizing rule per context, including the compact variant.
 *
 * Injected as text into each self-contained `webview.html` at load (CSP forbids
 * a shared script/stylesheet) rather than imported at webview runtime.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentProvider } from '../manifest/types.js';

/** One registered agent core: its canonical display name + icon asset. */
export interface AgentCoreMeta {
  /** Canonical provider name (e.g. "Claude Code"). */
  label: string;
  /** Canonical SVG asset file under `model/icons/agent/`. */
  icon: string;
}

/**
 * THE agent-core registry. A new provider = one entry here + one file in
 * `model/icons/agent/`; nothing else in the identity system changes.
 * Keyed by `AgentProvider` so a provider can never be registered in one
 * surface and missing from another.
 */
export const AGENT_PROVIDERS: Readonly<Record<AgentProvider, AgentCoreMeta>> = {
  claude: { label: 'Claude Code', icon: 'claude-code.svg' },
  codex: { label: 'Codex', icon: 'codex.svg' },
  antigravity: { label: 'Antigravity CLI', icon: 'antigravity-cli.svg' },
  opencode: { label: 'OpenCode', icon: 'opencode.svg' },
};

/** Agent provider id → display label, derived from the registry. */
export const AGENT_PROVIDER_LABELS: Readonly<Record<AgentProvider, string>> = Object.fromEntries(
  Object.entries(AGENT_PROVIDERS).map(([provider, meta]) => [provider, meta.label]),
) as Record<AgentProvider, string>;

const ICONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'icons', 'agent');

/**
 * Strip the parts of a canonical asset that are wrong for inline injection:
 * the `width/height="1em"` (CSS owns sizing), the inline `style`, the `<title>`
 * (the icon spans are aria-hidden; a title would surface to no one), and
 * inter-tag whitespace (keeps the injected blob small).
 */
function normalizeSvg(raw: string): string {
  return raw
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '')
    .replace(/\s(width|height)="1em"/g, '')
    .replace(/\sstyle="[^"]*"/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}

/** Registered provider id → normalized inline SVG, loaded once from the asset dir. */
const ICON_CACHE: Record<string, string> = {};
let ICONS_LOADED = false;

function loadAgentIcons(): void {
  if (ICONS_LOADED) return;
  for (const [provider, meta] of Object.entries(AGENT_PROVIDERS)) {
    try {
      ICON_CACHE[provider] = normalizeSvg(readFileSync(join(ICONS_DIR, meta.icon), 'utf8'));
    } catch {
      // A missing asset degrades to the label-only badge — never a throw that
      // takes down the webview with it (same stance as the xterm vendor path).
      ICON_CACHE[provider] = '';
    }
  }
  ICONS_LOADED = true;
}

/** The normalized inline SVG for a provider; '' for an unknown/unloadable one. */
export function agentIconSvg(provider: string): string {
  loadAgentIcons();
  return ICON_CACHE[provider] ?? '';
}

/** Agent provider id → inline SVG icon string ('' when the asset is missing). */
export const AGENT_ICONS: Readonly<Record<AgentProvider, string>> = Object.fromEntries(
  Object.keys(AGENT_PROVIDERS).map((provider) => [provider, agentIconSvg(provider)]),
) as Record<AgentProvider, string>;

/** Placeholder swapped for the agent badge CSS; sits inside each webview's `<style>`. */
export const AGENT_CSS_MARKER = '/*KARST_AGENT_CSS*/';

/** Placeholder swapped for the agent badge JS; sits as the first statement in each webview's `<script>`. */
export const AGENT_JS_MARKER = '/*KARST_AGENT_JS*/';

/**
 * The `.agentbadge`/`.agenticon`/`.agentname` rules plus the identity component
 * (`.agent-identity*`) shared by every agent display. The component keeps the
 * provider name and model name as SEPARATE spans with distinct roles, so the
 * two identities stay visually separated everywhere the component renders.
 */
export function agentIdentityCss(): string {
  return (
    '.agentbadge{display:inline-flex;align-items:center;gap:5px}' +
    // Unscoped: the mark also stands alone (timeline rows, origin chips).
    '.agenticon{flex:none;width:14px;height:14px;display:inline-flex}' +
    '.agenticon svg{width:100%;height:100%;display:block}' +
    '.agentbadge .agentname{font-weight:600}' +
    // ── the identity component: [icon] Provider · Model ─────────────
    '.agent-identity{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:100%}' +
    '.agent-identity-icon{flex:none;width:14px;height:14px;display:inline-flex}' +
    '.agent-identity-icon svg{width:100%;height:100%;display:block}' +
    '.agent-identity-name{font-weight:600;white-space:nowrap}' +
    '.agent-identity-sep{color:var(--k-text-faint);flex:none}' +
    // The model is subordinate metadata: muted, and the one part that
    // truncates when the run is tight.
    '.agent-identity-model{color:var(--k-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}' +
    // Compact (terminal-friendly) variant: 12px mark, tighter run.
    '.agent-identity.compact{gap:4px}' +
    '.agent-identity.compact .agent-identity-icon{width:12px;height:12px}'
  );
}

/**
 * The JS blob defining `AGENT_PROVIDERS`, `AGENT_PROVIDER_LABELS`, `AGENT_ICONS`,
 * `agentBadgeHtml`, `agentIconHtml`, and `agentIdentityHtml` in the webview's
 * global script scope. Emitted as plain statements (no wrapping `<script>` tag)
 * so it can be injected as the first lines of an existing block.
 *
 * `agentIdentityHtml` is the ONE reusable component: `[icon] Provider · Model`,
 * with the model omitted when absent and a `compact` terminal-friendly variant.
 * The label/icon functions delegate to the same `AGENT_PROVIDERS` registry, so
 * a provider registered once renders identically through every surface.
 */
export function agentIdentityJs(): string {
  const providers = Object.fromEntries(
    Object.entries(AGENT_PROVIDERS).map(([provider, meta]) => [provider, { ...meta, icon: agentIconSvg(provider) }]),
  );
  return (
    `const AGENT_PROVIDERS = ${JSON.stringify(providers)};\n` +
    `const AGENT_PROVIDER_LABELS = ${JSON.stringify(AGENT_PROVIDER_LABELS)};\n` +
    `const AGENT_ICONS = ${JSON.stringify(AGENT_ICONS)};\n` +
    // Falls back to the raw id (title-cased) for a provider with no known
    // label/icon, so a future provider degrades gracefully instead of blank.
    'function agentMeta(p) {\n' +
    '  return Object.prototype.hasOwnProperty.call(AGENT_PROVIDERS, p) ? AGENT_PROVIDERS[p] : null;\n' +
    '}\n' +
    'function agentLabel(p) {\n' +
    '  const id = p || "";\n' +
    '  const meta = agentMeta(id);\n' +
    '  return meta ? meta.label : (id.charAt(0).toUpperCase() + id.slice(1));\n' +
    '}\n' +
    'function agentIconHtml(provider) {\n' +
    '  const meta = agentMeta(provider);\n' +
    '  const icon = meta ? meta.icon : "";\n' +
    '  return icon ? \'<span class="agenticon" aria-hidden="true">\' + icon + \'</span>\' : "";\n' +
    '}\n' +
    // The name-only badge (icon + name) — the selector/trigger form.
    'function agentBadgeHtml(provider) {\n' +
    '  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;" }[c]));\n' +
    '  return \'<span class="agentbadge">\' + agentIconHtml(provider) + \'<span class="agentname">\' + esc(agentLabel(provider)) + \'</span></span>\';\n' +
    '}\n' +
    // THE identity component: [icon] Provider · Model. `model` is the already
    // resolved model label (''/null omits it); `compact` selects the small
    // terminal-friendly variant. Provider and model stay separate elements so
    // no layout can ever blur them together.
    'function agentIdentityHtml(provider, model, compact) {\n' +
    '  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",\'"\':"&quot;" }[c]));\n' +
    '  const p = provider || "";\n' +
    '  const meta = agentMeta(p);\n' +
    '  const icon = meta && meta.icon\n' +
    '    ? \'<span class="agent-identity-icon" aria-hidden="true">\' + meta.icon + \'</span>\'\n' +
    '    : "";\n' +
    '  const name = \'<span class="agent-identity-name">\' + esc(agentLabel(p)) + \'</span>\';\n' +
    '  const modelHtml = model\n' +
    '    ? \'<span class="agent-identity-sep" aria-hidden="true">·</span><span class="agent-identity-model">\' + esc(model) + \'</span>\'\n' +
    '    : "";\n' +
    '  return \'<span class="agent-identity\' + (compact ? \' compact\' : \'\') + \'"\' + (p ? \' data-provider="\' + esc(p) + \'"\' : \'\') + \'>\'\n' +
    '    + icon + name + modelHtml + \'</span>\';\n' +
    '}'
  );
}

/** Replace the agent CSS/JS markers with the emitted blocks; no-op per marker if absent. */
export function injectAgentIdentity(html: string): string {
  return html
    .replace(AGENT_CSS_MARKER, agentIdentityCss())
    .replace(AGENT_JS_MARKER, agentIdentityJs());
}
