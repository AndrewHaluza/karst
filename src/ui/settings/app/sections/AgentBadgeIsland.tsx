import { useEffect, useRef } from 'react';

export type AgentBadgeMount = (element: HTMLElement, provider: string) => void;

export interface AgentBadgeIslandProps {
  readonly provider: string;
  readonly mount?: AgentBadgeMount | null;
}

export function AgentBadgeIsland({ provider, mount }: AgentBadgeIslandProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    const badge = mount ?? ((globalThis as any).agentBadgeInto as AgentBadgeMount | null);
    if (!root || !badge) return;
    badge(root, provider);
  }, [mount, provider]);

  return <span ref={rootRef} className="agentbadge" />;
}
