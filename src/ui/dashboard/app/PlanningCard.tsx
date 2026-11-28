/**
 * The planning session a ticket was filed from (T1400): the `P<n>` identifier in header row 1 is the link that
 * opens the session (`@ui:UI-R09c`, so the card has no duplicate "Open session" button), and hovering it or
 * moving keyboard focus onto it reveals the host's facts about the session (`@ui:UI-R22`, part of the header
 * spec's §4). Clicking `P<n>` posts `plan-open`; the card's one action opens the session's artifacts folder.
 */
import { useRef } from 'react';
import { formatFullDateTime } from '../../../model/dateText.js';
import { instantMs } from '../../../model/inside/types.js';
import type { DashboardOriginView } from '../stateTypes.js';
import { agentName } from './AgentIcon.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { selectModelsByCore } from './headerSlices.js';
import { useHoverCard } from './useHoverCard.js';
import { usePendingAction } from './usePendingAction.js';
import { useSlice } from './useSlice.js';

/** The card's preferred width: 12 large control heights, the same width the `.hoverCard` rule composes. */
const CARD_WIDTH = 360;

const LINK_ID = 'planLink';
const CARD_ID = 'planCard';
const TITLE_ID = 'planCardTitle';

/**
 * The session's start, formatted with the dashboard's own helper. `planning_sessions.created_at` is SQLite's
 * `datetime('now')` (`YYYY-MM-DD HH:MM:SS`, UTC, no separator or zone), so it is normalised through `instantMs`
 * first; an unparseable stamp renders no Started row rather than "Invalid Date".
 */
export function formatStarted(at: string): string {
  const ms = instantMs(at);
  return Number.isFinite(ms) ? formatFullDateTime(new Date(ms).toISOString()) : '';
}

/** `P28 · <title>` and the `status · core · model` line; the model is left out when the session names none. */
function subtitleOf(origin: DashboardOriginView, modelLabel: string): string {
  return ['Planning session', origin.session.status, agentName(origin.session.core), modelLabel]
    .filter((part) => part !== '')
    .join(' · ');
}

/** `4 accepted · 0 pending · 1 discarded`: the session's drafts by outcome. */
function draftsText(drafts: DashboardOriginView['session']['drafts']): string {
  return `${drafts.accepted} accepted · ${drafts.pending} pending · ${drafts.discarded} discarded`;
}

/**
 * The row-1 `P<n>` link with its hover/focus card. Rendered only for a ticket a draft produced (no origin, no
 * link); at the tight tier CSS hides the link and the ⋯ menu carries the same action.
 */
export function PlanningLink({ origin }: { readonly origin: DashboardOriginView }) {
  const send = useDashboardSend();
  const modelsByCore = useSlice(selectModelsByCore);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const { open, triggerProps, cardProps } = useHoverCard({ id: 'planning-card', triggerRef, cardRef, width: CARD_WIDTH });
  const session = origin.session;
  const onPlanOpen = usePendingAction((requestId) => send.planOpen(session.id, requestId));
  const onArtifacts = usePendingAction((requestId) => send.planArtifacts(session.id, requestId));
  const modelLabel = session.model ? (modelsByCore[session.core] ?? []).find((m) => m && m.id === session.model)?.label || session.model : '';
  const started = formatStarted(session.createdAt);
  return (
    <>
      <button
        id={LINK_ID}
        ref={triggerRef}
        type="button"
        className="k-link planLink"
        data-act="plan-open"
        data-session-id={session.id}
        aria-expanded={open ? 'true' : 'false'}
        aria-controls={open ? CARD_ID : undefined}
        onClick={onPlanOpen}
        {...triggerProps}
      >
        {session.ref}
      </button>
      {open ? (
        <div id={CARD_ID} ref={cardRef} className="popover hoverCard planCard open" role="dialog" aria-labelledby={TITLE_ID} {...cardProps}>
          <div id={TITLE_ID} className="planCardTitle">
            {`${session.ref} · ${session.title}`}
          </div>
          <div className="planCardSub">{subtitleOf(origin, modelLabel)}</div>
          <table className="planCardTable">
            <tbody>
              <tr>
                <th scope="row">This ticket</th>
                <td>{`from ${origin.draftRef}`}</td>
              </tr>
              <tr>
                <th scope="row">Drafts</th>
                <td>{draftsText(session.drafts)}</td>
              </tr>
              {started ? (
                <tr>
                  <th scope="row">Started</th>
                  <td>{started}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <div className="planCardActions">
            <button
              type="button"
              className="k-btn k-btn--secondary k-btn--sm"
              data-act="plan-artifacts"
              data-session-id={session.id}
              onClick={onArtifacts}
            >
              Artifacts
            </button>
          </div>
          <div className="planCardHint">{`Click ${session.ref} to open the session.`}</div>
        </div>
      ) : null}
    </>
  );
}
