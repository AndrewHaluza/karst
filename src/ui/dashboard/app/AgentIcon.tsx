/**
 * The agent core's icon, markup owned by the shared agent-identity runtime
 * (`agentIconHtml`, `/*KARST_AGENT_JS*\/`: a static, trusted `<span class="agenticon"><svg/></span>`).
 * The one sanctioned raw-HTML site of the dashboard app, mirroring sidebar `Icon.tsx`.
 */
import { memo } from 'react';

const iconHtml = (provider: string): string =>
  (globalThis as unknown as { agentIconHtml?: (p: string) => string }).agentIconHtml?.(provider) ?? '';

export const AgentIcon = memo(function AgentIcon({ provider }: { readonly provider: string }) {
  return <span className="agenticon-island" dangerouslySetInnerHTML={{ __html: iconHtml(provider) }} />;
});

const MARKUP_RE = /^<span class="([^"]*)" aria-hidden="true">([\s\S]*)<\/span>$/;
const runtimeFn = (name: string): ((arg: string) => string) | undefined =>
  (globalThis as unknown as Record<string, ((arg: string) => string) | undefined>)[name];

/**
 * The runtime's bare icon mark with NO wrapper element: `<span class="agenticon|provicon" aria-hidden="true"><svg/></span>`
 * (`agentIconHtml` / `providerIconHtml`). It is re-created as React's own span around the svg markup, so the DOM is the
 * runtime's exactly (the header's parity snapshots pin it). Renders nothing for a provider without a mark.
 */
export const RuntimeIcon = memo(function RuntimeIcon({ kind, provider }: { readonly kind: 'agent' | 'provider'; readonly provider: string }) {
  const m = MARKUP_RE.exec(runtimeFn(kind === 'agent' ? 'agentIconHtml' : 'providerIconHtml')?.(provider) ?? '');
  return m ? <span className={m[1]} aria-hidden="true" dangerouslySetInnerHTML={{ __html: m[2]! }} /> : null;
});

/** The runtime's display name for an agent core (`agentLabel`), falling back to the raw id. */
export const agentName = (provider: string): string => runtimeFn('agentLabel')?.(provider) ?? provider;
