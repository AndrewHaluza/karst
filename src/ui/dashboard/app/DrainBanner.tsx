/**
 * The reload-drain banner (T1211, @arch:DRAIN-01): one line that names the live runs a waiting "Reload window when
 * idle" waits for, with Cancel reload. It renders inside the `#blocked` portal, before any block banner.
 */
import { memo, useCallback } from 'react';
import type { DashboardDrain } from '../stateTypes.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { drainBannerText } from './drainSlices.js';
import { usePendingAction } from './usePendingAction.js';

export const DrainBanner = memo(function DrainBanner({ drain }: { readonly drain: DashboardDrain }) {
  const send = useDashboardSend();
  const onCancel = usePendingAction(useCallback((requestId: string) => send.cancelReload(requestId), [send]));
  return (
    <div className="drain-banner" data-region="drain-banner" role="status">
      <span className="fdot" aria-hidden="true" />
      <span className="ftext">
        <span className="freason">{drainBannerText(drain)}</span>
      </span>
      <div className="facts">
        <button type="button" className="k-btn k-btn--secondary k-btn--sm" data-act="cancel-reload" data-region="drain-cancel" onClick={onCancel}>
          Cancel reload
        </button>
      </div>
    </div>
  );
});
