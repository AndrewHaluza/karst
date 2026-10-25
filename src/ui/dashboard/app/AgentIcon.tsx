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
