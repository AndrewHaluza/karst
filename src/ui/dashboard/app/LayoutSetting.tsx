/**
 * The "Layout" quick setting of the "..." menu: a framed radiogroup of two icon + label options, Centered and
 * Full width. One workspace preference for every open dashboard (host-owned, `layout` push). A click posts the
 * wanted mode and marks only the clicked option pending (UI-R11); the selection stays on the old mode until the
 * host answers with a `layout` push (UI-R15). WAI-ARIA radio keyboard: one tab stop on the selected option,
 * Left/Right (and Up/Down) move to the neighbour and select it.
 */
import { memo, useCallback, type KeyboardEvent } from 'react';
import type { DashboardLayout } from '../../../model/dashboardLayout.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { selectLayout } from './headerSlices.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';

interface LayoutOption {
  readonly value: DashboardLayout;
  readonly label: string;
  readonly icon: string;
}

const OPTIONS: readonly LayoutOption[] = [
  { value: 'centered', label: 'Centered', icon: 'align-box-center-middle' },
  { value: 'full', label: 'Full width', icon: 'arrow-autofit-width' },
];

const ICON_SIZE = 14;
const TITLE_ID = 'layoutSettingTitle';
/** Arrow keys and the step each one takes through the options. */
const KEY_STEP: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

function LayoutOptionButton({ option, selected }: { readonly option: LayoutOption; readonly selected: boolean }) {
  const send = useDashboardSend();
  const onClick = usePendingAction((requestId) => send.setLayout(option.value, requestId));
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      className={`k-btn k-btn--sm ${selected ? 'k-btn--secondary' : 'k-btn--ghost'}`}
      data-act="set-layout"
      data-layout-option={option.value}
      onClick={onClick}
    >
      <Icon name={option.icon} size={ICON_SIZE} />
      <span>{option.label}</span>
    </button>
  );
}

export const LayoutSetting = memo(function LayoutSetting() {
  const layout = useSlice(selectLayout);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    const step = KEY_STEP[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const radios = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const at = radios.indexOf(document.activeElement as HTMLButtonElement);
    const next = radios[(Math.max(at, 0) + step + radios.length) % radios.length];
    // Focus follows selection: the click runs the same pending + post path as a pointer press.
    next?.focus();
    next?.click();
  }, []);
  return (
    <div className="settingRow">
      <div className="settingCopy">
        <div id={TITLE_ID} className="settingTitle">Layout</div>
        <div className="settingHelp">Global · applies to every dashboard tab.</div>
      </div>
      <div role="radiogroup" aria-labelledby={TITLE_ID} className="k-segmented" onKeyDown={onKeyDown}>
        {OPTIONS.map((option) => (
          <LayoutOptionButton key={option.value} option={option} selected={layout === option.value} />
        ))}
      </div>
    </div>
  );
});
