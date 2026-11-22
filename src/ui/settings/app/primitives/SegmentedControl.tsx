/**
 * The segmented control primitive (SET-48, UI-R08).
 *
 * A one-of-N choice rendered as a framed radiogroup: the Sandbox backend rows on
 * the Agents page are the first caller, but the pattern (host / sbx / docker,
 * wide / full) is shared, so the class and the WAI-ARIA radio semantics live in
 * one place instead of being re-declared per section.
 *
 * Behavior, per the radio pattern:
 * - exactly one tab stop: the selected option has `tabIndex=0`, the rest `-1`;
 *   when the value matches no option (an unsupported backend in karst.yml), the
 *   first enabled option takes it so the broken row stays reachable (UI-R26);
 * - ArrowLeft / ArrowRight (and ArrowUp / ArrowDown, as the dashboard's layout
 *   control already accepts) move the selection and the focus together;
 * - Home / End jump to the first / last enabled option.
 *
 * The options are `Button`s, so the shared `.k-btn` vocabulary and the busy /
 * disabled semantics stay owned by `Button` (UI-R07).
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { Button } from './Button.js';

export interface SegmentedOption {
  readonly value: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export interface SegmentedControlProps {
  /** Id of the visible label the group is named by. */
  readonly labelId: string;
  readonly value: string;
  readonly options: readonly SegmentedOption[];
  readonly onChange: (value: string) => void;
  /** Disables every option (a core with no alternative backend). */
  readonly disabled?: boolean;
  readonly className?: string;
}

const NEXT_STEP: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

/** The next enabled option index in `step` direction, wrapping. */
function stepIndex(
  options: readonly SegmentedOption[],
  from: number,
  step: number,
): number | null {
  const count = options.length;
  for (let moved = 1; moved <= count; moved += 1) {
    const candidate = (from + step * moved + count * moved) % count;
    if (!options[candidate]?.disabled) return candidate;
  }
  return null;
}

export function SegmentedControl({
  labelId,
  value,
  options,
  onChange,
  disabled = false,
  className,
}: SegmentedControlProps) {
  const selectedIndex = options.findIndex((option) => option.value === value);
  const firstEnabled = options.findIndex((option) => !option.disabled);
  // A radiogroup always owns exactly one tab stop. When the saved value is not
  // among the options (an unsupported backend in karst.yml), no option is
  // checked; the FIRST ENABLED option must still be reachable so a keyboard
  // user can repair the manifest (UI-R26 / WAI-ARIA radiogroup).
  const tabStop = selectedIndex >= 0 ? selectedIndex : firstEnabled;
  const groupClass = ['k-segmented', className].filter((c): c is string => Boolean(c)).join(' ');

  const selectAt = (index: number, event: KeyboardEvent<HTMLDivElement>): void => {
    const option = options[index];
    if (!option || option.disabled || disabled) return;
    event.preventDefault();
    onChange(option.value);
    // Focus follows selection, as the radio pattern requires.
    event.currentTarget
      .querySelectorAll<HTMLButtonElement>('[role="radio"]')
      .item(index)
      ?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const from = selectedIndex >= 0 ? selectedIndex : Math.max(firstEnabled, 0);
    if (event.key === 'Home') {
      selectAt(options.findIndex((option) => !option.disabled), event);
      return;
    }
    if (event.key === 'End') {
      const last = [...options].reverse().findIndex((option) => !option.disabled);
      selectAt(last < 0 ? -1 : options.length - 1 - last, event);
      return;
    }
    const step = NEXT_STEP[event.key];
    if (step === undefined) return;
    const next = stepIndex(options, from, step);
    if (next !== null) selectAt(next, event);
  };

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelId}
      className={groupClass}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Button
            key={option.value}
            role="radio"
            aria-checked={selected}
            tabIndex={index === tabStop ? 0 : -1}
            variant={selected ? 'secondary' : 'ghost'}
            size="sm"
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
