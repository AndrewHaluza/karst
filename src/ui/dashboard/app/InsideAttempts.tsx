/**
 * Round row: thin R<n> tabs (glyph + label; the selected tab adds `of N · latest|live`) scoping ONE gate stage's whole process list (Gates + Tester /
 * Review), so they render once in the stage header, never per process row. `view.attempts` is absent OR holds fewer
 * than 2 entries whenever the stage never looped, so this renders NOTHING (no wrapper, no empty tablist).
 *
 * Selection is host-held: a click posts `select-gate-attempt` and waits for the next snapshot to move
 * `aria-selected`, with no local optimistic flip (the same rule the stage menu already follows for a
 * host-authoritative state). Roving tabindex (WAI-ARIA tabs): only the selected tab sits in the Tab order; Left /
 * Right move both focus and the host selection between siblings, without wrapping.
 */
import { Fragment, useCallback, useRef, type KeyboardEvent } from 'react';
import type { GateAttemptView } from '../../../model/inside/rounds.js';
import type { AttemptStage } from '../messages.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { withKeys } from './insideText.js';

export function AttemptTabs({
  stageKey,
  attempts,
  selected,
  caption,
}: {
  readonly stageKey: string;
  readonly attempts: readonly GateAttemptView[] | undefined;
  readonly selected: string | undefined;
  /** Host-authored muted caption for the selected attempt, shown at the end of the row (UI-R31). */
  readonly caption?: string;
}) {
  const send = useDashboardSend();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  // Scoped like the tabs' own ids: two stages' rows can render beside each other.
  const captionId = `attempt-caption-${stageKey}`;
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = attempts?.[e.key === 'ArrowRight' ? index + 1 : index - 1];
      if (!next) return;
      e.preventDefault();
      send.selectGateAttempt(stageKey as AttemptStage, next.key);
      // Focus follows selection at once (the roving-tabindex pattern); the next snapshot carries the real aria-selected.
      tabs.current[attempts!.indexOf(next)]?.focus();
    },
    [attempts, send, stageKey],
  );
  if (!attempts || attempts.length < 2) return null;
  const keys = attempts.map((a) => a.key).join(',');
  return (
    <div
      className="attempt-tabs"
      role="tablist"
      aria-label="Rounds"
      // A screen reader hears which round is selected AND why it opened: the
      // caption describes the whole row, so it is the tablist's description,
      // never a tab's accessible name.
      aria-describedby={caption ? captionId : undefined}
    >
      <span className="attempt-tabs-label" aria-hidden="true">
        Rounds
      </span>
      {withKeys(attempts, (a) => a.key).map(([key, a], i) => {
        const isSelected = a.key === selected;
        // The kind tag names why the tab is a different loop (`R2 · CI`); it
        // stays in the accessible name too, so the kind is never visual-only.
        const name = a.tag ? `${a.label} · ${a.tag}` : a.label;
        return (
          // The id is STAGE-scoped: the ordinal alone would collide the moment a second stage's tablist is rendered beside this one.
          <Fragment key={key}>
            {i > 0 ? (
              <span className="attempt-conn" aria-hidden="true" />
            ) : null}
            <button
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              className="attempt-tab"
              aria-label={
                isSelected
                  ? `${name} ${a.tail}, ${a.statusLabel}`
                  : `${name}, ${a.statusLabel}`
              }
              role="tab"
              id={`attempt-tab-${stageKey}-${i}`}
              aria-selected={isSelected ? 'true' : 'false'}
              tabIndex={isSelected ? 0 : -1}
              data-act="select-gate-attempt"
              data-stage={stageKey}
              data-key={a.key}
              data-index={i}
              data-keys={keys}
              onClick={() =>
                send.selectGateAttempt(stageKey as AttemptStage, a.key)
              }
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {/* Icon-only glyph (UI-R28b) is the non-colour carrier (UI-R28); the status word lives in the accessible name. */}
              <span className={`glyph ${a.status}`} aria-hidden="true" />
              <span className="attempt-tab-label">{a.label}</span>
              {a.tag ? (
                <span className="attempt-tag" aria-hidden="true">
                  · {a.tag}
                </span>
              ) : null}
              {isSelected ? (
                <span className="attempt-tab-tail">{a.tail}</span>
              ) : null}
            </button>
          </Fragment>
        );
      })}
      {/* The selected round's plain facts, muted, at the END of the row: a tab
          row fact, not an attention banner. The row already wraps, so the
          tight tier puts it on its own line under the tabs. */}
      {caption ? (
        <span className="attempt-caption" id={captionId}>
          {caption}
        </span>
      ) : null}
    </div>
  );
}
