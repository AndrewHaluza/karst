import { useEffect, useRef } from 'react';
import type { AgentBadgeMount } from './AgentBadgeIsland.js';

/**
 * The agent core's icon alone, as an opaque island filled by the shared
 * `agentIconInto` (`/*KARST_AGENT_JS*\/`). Same shape as AgentBadgeIsland,
 * for places that already print the core's name beside it.
 */
export function AgentIconIsland({ provider, mount }: { readonly provider: string; readonly mount?: AgentBadgeMount | null }) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    const fill = mount ?? ((globalThis as { agentIconInto?: AgentBadgeMount }).agentIconInto ?? null);
    if (!root || !fill) return;
    fill(root, provider);
  }, [mount, provider]);
  return <span ref={rootRef} className="agenticon-island" />;
}
