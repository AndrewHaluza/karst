/**
 * The opaque-island wrapper for the shared agent picker (NDL-126 §9.4 R-X3).
 *
 * `agentPicker.webview.js` is a vanilla runtime that builds its own DOM inside
 * a root element. React must never reconcile children into that element or the
 * next render would throw away the picker's state (open menu, caret, focus). So
 * the island renders an EMPTY `<div>` with no React children at all, and the
 * runtime is mounted into it once per mount and refreshed when its inputs change.
 *
 * That makes re-render preservation a structural property rather than a
 * convention — and the component test for it (`AgentPickerIsland.test.tsx`)
 * proves it by interacting with the island's own control across a re-render.
 *
 * Mounting is an EFFECT because it is external sync with a runtime React does
 * not own (R-X4's permitted case); the picker's identity is passed as options,
 * never as children.
 */
import { useEffect, useRef } from 'react';
import {
  pageAgentPicker,
  type AgentPickerMount,
  type AgentPickerOptions,
} from '../hostBridge.js';

export interface AgentPickerIslandProps extends AgentPickerOptions {
  /** Injected in tests; defaults to the `KARST_AGENT_PICKER_JS` page global. */
  readonly mount?: AgentPickerMount | null;
}

export function AgentPickerIsland({ mount, ...options }: AgentPickerIslandProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The latest options are read through a ref so a rebuild is triggered by a
  // change of IDENTITY only, not by every parent render — otherwise an unrelated
  // `state` push would tear down an open menu mid-interaction.
  const latest = useRef(options);
  latest.current = options;
  // Rebuild when any INPUT changes. Callers memoise `cores` / `catalog` / `recent`,
  // so a parent re-render on unrelated state does not re-run this — which is what
  // keeps an open menu and a caret alive across an ordinary `state` push.
  const { cores, catalog, recent, inherit, inheritCore, showEffort, disabled, compact } = options;
  const { core, model, effort } = options.value;

  useEffect(() => {
    const root = rootRef.current;
    const picker = mount ?? pageAgentPicker();
    if (!root || !picker) return;
    picker(root, {
      ...latest.current,
      onChange: (value) => latest.current.onChange(value),
    });
  }, [mount, cores, catalog, recent, inherit, inheritCore, showEffort, core, model, effort, disabled, compact]);

  return <div ref={rootRef} className="agent-picker-island" />;
}
