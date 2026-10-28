/**
 * Round switcher (Option B, T6): the attempt tabs scoping ONE gate stage's whole process list (Gates + Tester /
 * Review), so they render once in the stage header, never per process row. `view.attempts` is absent OR holds fewer
 * than 2 entries whenever the stage never looped, so this renders NOTHING (no wrapper, no empty tablist).
 *
 * Selection is host-held: a click posts `select-gate-attempt` and waits for the next snapshot to move
 * `aria-selected`, with no local optimistic flip (the same rule the stage menu already follows for a
 * host-authoritative state). Roving tabindex (WAI-ARIA tabs): only the selected tab sits in the Tab order; Left /
 * Right move both focus and the host selection between siblings, without wrapping.
 */
import { Fragment, useCallback, useRef, type KeyboardEvent } from "react";
import type { GateAttemptView } from "../../../model/inside/rounds.js";
import type { GateStage } from "../../../store/ticketGates.js";
import { useDashboardSend } from "./DashboardAppContext.js";
import { withKeys } from "./insideText.js";

export function AttemptTabs({
  stageKey,
  attempts,
  selected,
}: {
  readonly stageKey: string;
  readonly attempts: readonly GateAttemptView[] | undefined;
  readonly selected: string | undefined;
}) {
  const send = useDashboardSend();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const next = attempts?.[e.key === "ArrowRight" ? index + 1 : index - 1];
      if (!next) return;
      e.preventDefault();
      send.selectGateAttempt(stageKey as GateStage, next.key);
      // Focus follows selection at once (the roving-tabindex pattern); the next snapshot carries the real aria-selected.
      tabs.current[attempts!.indexOf(next)]?.focus();
    },
    [attempts, send, stageKey],
  );
  if (!attempts || attempts.length < 2) return null;
  const keys = attempts.map((a) => a.key).join(",");
  return (
    <div className="attempt-tabs" role="tablist" aria-label="Rounds">
      <span className="attempt-tabs-label" aria-hidden="true">
        Rounds
      </span>
      {withKeys(attempts, (a) => a.key).map(([key, a], i) => {
        const isSelected = a.key === selected;
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
              className={`attempt-tab ${a.status}`}
              aria-label={
                isSelected
                  ? `${a.label}, ${a.statusLabel}, ${a.tail}`
                  : `${a.label}, ${a.statusLabel}`
              }
              role="tab"
              id={`attempt-tab-${stageKey}-${i}`}
              aria-selected={isSelected ? "true" : "false"}
              tabIndex={isSelected ? 0 : -1}
              data-act="select-gate-attempt"
              data-stage={stageKey}
              data-key={a.key}
              data-index={i}
              data-keys={keys}
              onClick={() =>
                send.selectGateAttempt(stageKey as GateStage, a.key)
              }
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {/* Icon-only glyph (UI-R28b) is the non-colour carrier (UI-R28); the status word lives in the accessible name. */}
              <span className={`glyph ${a.status}`} aria-hidden="true" />
              <span className="attempt-tab-label">{a.label}</span>
              {isSelected ? (
                <span className="attempt-tab-tail">{a.tail}</span>
              ) : null}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
