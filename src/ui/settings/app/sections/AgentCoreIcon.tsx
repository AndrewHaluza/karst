/**
 * One agent core's brand mark as an opaque island (NDL-126 §9.4 R-X6).
 *
 * `agentIconInto` — the MOUNTING form of the shared agent-identity runtime in
 * `model/agentIdentity.ts` — builds the icon inside a container React never
 * reconciles children into. A React component cannot adopt the icon's SVG string
 * instead: that would need `dangerouslySetInnerHTML`, which R-X6 bans, and the
 * icon paths are host-side file reads. The island keeps one definition of the
 * mark (no mirrored SVG) and degrades to nothing when the blob is absent.
 */
import { useEffect, useRef } from 'react';

/** `agentIconInto(el, provider)` from the injected agent-identity blob. */
export type AgentIconMount = (element: HTMLElement, provider: string) => void;

export interface AgentCoreIconProps {
  readonly provider: string;
  /** Injected in tests; defaults to the `agentIconInto` page global. */
  readonly mount?: AgentIconMount | null;
}

function agentIconMount(
  scope: { agentIconInto?: AgentIconMount } = globalThis as { agentIconInto?: AgentIconMount },
): AgentIconMount | null {
  return scope.agentIconInto ?? null;
}

export function AgentCoreIcon({ provider, mount }: AgentCoreIconProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    const into = mount ?? agentIconMount();
    if (!root || !into) return;
    into(root, provider);
  }, [mount, provider]);
  return <span ref={rootRef} className="agenticon backend-core-icon" aria-hidden="true" />;
}
