/**
 * The pinned toolbar: create-ticket and start-planning on the left, the monitor
 * handoffs (resource monitor, token usage) and settings on the right. Every
 * control posts through the shared pending path.
 */
import type { ReactNode } from 'react';
import { ActButton } from './action.js';
import { ToolbarGlyph } from './Icon.js';

function ToolbarButton({ act, label, paths }: { readonly act: string; readonly label: string; readonly paths: readonly string[] }): ReactNode {
  return (
    <ActButton spec={{ act }} className="k-iconbtn" aria-label={label} title={label}>
      <ToolbarGlyph paths={paths} />
    </ActButton>
  );
}

export function Toolbar() {
  return (
    <div className="toolbar">
      <ToolbarButton act="create" label="Create ticket" paths={['M12 5l0 14', 'M5 12l14 0']} />
      <ToolbarButton
        act="plan-create"
        label="Start planning session"
        paths={[
          'M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7',
          'M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3',
          'M9.7 17l4.6 0',
        ]}
      />
      <span className="sp" />
      <ToolbarButton
        act="open-resources"
        label="Open resource monitor"
        paths={['M10 13a2 2 0 1 0 4 0a2 2 0 1 0 -4 0', 'M13.45 11.55l2.05 -2.05', 'M6.4 20a9 9 0 1 1 11.2 0l-11.2 0']}
      />
      <ToolbarButton
        act="open-token-usage"
        label="Open token usage"
        paths={[
          'M3 13a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -6',
          'M15 9a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -10',
          'M9 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -14',
          'M4 20h14',
        ]}
      />
      <ToolbarButton
        act="open-settings"
        label="Open settings"
        paths={[
          'M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065',
          'M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0',
        ]}
      />
    </div>
  );
}
