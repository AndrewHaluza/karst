/**
 * The Inside block's shared primitives, with the vanilla renderers' DOM exactly: the action button and the object
 * link (both post `inside-action`), the agent identity run, and the token pill. Every part is host-shipped; the
 * webview never parses prose, formats a number or derives a verdict (UI-R31).
 */
import { memo, useCallback, type MouseEvent } from 'react';
import type { AgentExecutionView, InsideProcessView, TokenUsageView, TypedInsideAction } from '../../../model/inside/types.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { RuntimeIcon, agentName } from './AgentIcon.js';
import { Icon } from './Icon.js';
import { INSIDE_ACTION_DANGER, INSIDE_ACTION_ICON, INSIDE_ACTION_LABEL, INSIDE_ACTION_OVERFLOW, INSIDE_ACTION_TITLE, insideActionSentence } from './insideText.js';
import { usePendingAction } from './usePendingAction.js';

/** Posts `inside-action` for one opaque action id, runtime-pending until the host answers. The control keeps one className whatever it shows. */
function useInsideAction(action: TypedInsideAction): (e: MouseEvent<HTMLElement>) => void {
  const send = useDashboardSend();
  const post = usePendingAction(useCallback((requestId: string) => send.insideAction(action.actionId, requestId), [send, action.actionId]));
  return useCallback(
    (e) => {
      e.preventDefault();
      post(e);
    },
    [post],
  );
}

/** A kind outside the closed vocabulary renders nothing, like a control the host never offered. */
export const InsideActionButton = memo(function InsideActionButton({ action }: { readonly action: TypedInsideAction }) {
  const onClick = useInsideAction(action);
  if (!INSIDE_ACTION_LABEL[action.kind]) return null;
  // The host may ship a count-bearing label ("Show 4 more"); the static map is the fallback, never a webview-computed count.
  const label = action.label || INSIDE_ACTION_LABEL[action.kind];
  // A danger action gets the danger variant (UI-R10b), so an irreversible control is never styled as an ordinary secondary button.
  // An overflow is the text button with a chevron (a row action is the secondary button).
  const overflow = INSIDE_ACTION_OVERFLOW.has(action.kind);
  const variant = INSIDE_ACTION_DANGER.has(action.kind) ? 'k-btn--danger' : overflow ? 'k-btn--link' : 'k-btn--secondary';
  const icon = INSIDE_ACTION_ICON[action.kind];
  const sentence = insideActionSentence(label ?? '', INSIDE_ACTION_TITLE[action.kind]);
  return (
    <button
      key={action.actionId}
      type="button"
      className={`k-btn ${variant} k-btn--sm${overflow ? ' overflow-btn' : ''}`}
      data-act="inside-action"
      data-action-id={action.actionId}
      title={sentence}
      aria-label={sentence}
      onClick={onClick}
    >
      {icon ? <Icon name={icon} /> : null}
      {label}
    </button>
  );
});

/** The timeline overflow control: a text button with a chevron-down icon and the hidden count; the full sentence is title and aria-label. */
export const OverflowButton = memo(function OverflowButton({ action, hidden }: { readonly action: TypedInsideAction; readonly hidden: number }) {
  const onClick = useInsideAction(action);
  const label = `Show all ${hidden} events`;
  return (
    <button type="button" className="k-btn k-btn--link k-btn--sm overflow-btn" data-act="inside-action" data-action-id={action.actionId} title={label} aria-label={label} onClick={onClick}>
      <Icon name="chevron-down" />
      {`${hidden} more`}
    </button>
  );
});

/**
 * A visible resource identifier IS its control (UI-R09c): a file path, a commit hash or a PR number renders as the
 * link that opens it, never as inert text beside a duplicate button. With no action it stays plain text.
 */
export const ObjLink = memo(function ObjLink({
  text,
  action,
  cls,
  title,
}: {
  readonly text: string | undefined;
  readonly action: TypedInsideAction | undefined;
  readonly cls: string;
  readonly title: string;
}) {
  if (!text) return null;
  if (!action) return <span className={`obj-link-plain ${cls}`}>{text}</span>;
  return <ObjAnchor text={text} action={action} cls={cls} title={title} />;
});

function ObjAnchor({ text, action, cls, title }: { readonly text: string; readonly action: TypedInsideAction; readonly cls: string; readonly title: string }) {
  const onClick = useInsideAction(action);
  return (
    <a className={`obj-link ${cls}`} href="#" data-act="inside-action" data-action-id={action.actionId} title={title} onClick={onClick}>
      {text}
    </a>
  );
}

/**
 * The core's mark as a named, focusable control: `aria-label` is the canonical core name at every tier, and the k-tooltip
 * (`data-tip`) says "core · model". At a tight container (<400 px) the visible core and model text drop and this mark is
 * all that is left (UI-R10c tight exception, RD-A11Y). The tooltip adds nothing the open row does not already show.
 */
export function CoreMark({ provider, core, tip }: { readonly provider: string; readonly core: string; readonly tip: string }) {
  return (
    <span className="agent-mark" role="img" aria-label={core} data-tip={tip} tabIndex={0}>
      <RuntimeIcon kind="agent" provider={provider} />
    </span>
  );
}

/** [agent name ·] core mark + core · model. The mark is the canonical provider icon, so a provider with no mark degrades to text. */
export const AgentId = memo(function AgentId({ x }: { readonly x: AgentExecutionView }) {
  return (
    <span className="agent-id">
      {x.agentName ? (
        <>
          <span className="agent-name">{x.agentName}</span>
          <span className="agent-sep">·</span>
        </>
      ) : null}
      {x.provider ? <CoreMark provider={x.provider} core={x.providerLabel || agentName(x.provider)} tip={[x.providerLabel || agentName(x.provider), x.modelLabel].filter(Boolean).join(' · ')} /> : null}
      {x.providerLabel ? <span className="agent-core">{x.providerLabel}</span> : null}
      {x.modelLabel ? (
        <>
          <span className="agent-sep">·</span>
          <span className="agent-model">{x.modelLabel}</span>
        </>
      ) : null}
    </span>
  );
});

/** The identity a row is entitled to show, in the §11 order: what RAN, else what settings SAY will run, else the host's absence copy. Never invented. */
export function Identity({ p }: { readonly p: InsideProcessView }) {
  if (p.execution) return <AgentId x={p.execution} />;
  if (p.configuredExecution) return <AgentId x={p.configuredExecution} />;
  if (p.identityNote) return <span className="identity-note">{p.identityNote}</span>;
  return null;
}

/** The token claim as the prototype's Σ pill. `unavailable` is NOT zero: it renders as a titled absence marker, never "0 tokens". */
export function TokenPill({ t }: { readonly t: TokenUsageView | undefined }) {
  if (!t) return null;
  if (t.state === 'unavailable') return <span className="token-stat" title={t.title}>usage unavailable</span>;
  // A running row whose count arrives only when the call ends: the reason is the text, never "0 tok".
  if (t.state === 'pending') {
    return (
      <span className="token-stat pending" title={t.title}>
        {t.label}
      </span>
    );
  }
  const estimateOnly = t.state === 'estimated' && t.estimateOnly === true;
  // Only a count read live from the transcript (`t.live`, a host fact) is marked: a running row with a stored count is not.
  const live = t.live === true;
  return (
    <span
      className={`token-stat${live ? ' live' : ''}${estimateOnly ? ' estimate' : ''}`}
      title={t.title ?? (t.exact ? `${t.exact} fresh tokens` : undefined)}
    >
      <span className="sigma">{estimateOnly ? '~Σ' : 'Σ'}</span>
      {`${t.total} tok`}
      {/* Cache reads ride BESIDE the headline, never inside it: context re-sent from the prompt cache is charged at a fraction of the fresh rate. */}
      {t.cacheRead ? (
        <span className="cache-read" title={`${t.cacheReadExact || t.cacheRead} tokens re-read from the prompt cache`}>
          {`+${t.cacheRead} cached`}
        </span>
      ) : null}
      {live ? <span className="live-word">live</span> : null}
    </span>
  );
}
