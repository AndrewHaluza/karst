/**
 * The Inside block's shared primitives, with the vanilla renderers' DOM exactly: the action button and the object
 * link (both post `inside-action`), the agent identity run, and the token pill. Every part is host-shipped; the
 * webview never parses prose, formats a number or derives a verdict (UI-R31).
 */
import { memo, useCallback, type MouseEvent } from 'react';
import type { AgentExecutionView, InsideProcessView, TokenUsageView, TypedInsideAction } from '../../../model/inside/types.js';
import { useDashboardSend } from './DashboardAppContext.js';
import { RuntimeIcon } from './AgentIcon.js';
import { INSIDE_ACTION_DANGER, INSIDE_ACTION_LABEL, INSIDE_ACTION_TITLE } from './insideText.js';
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
  const variant = INSIDE_ACTION_DANGER.has(action.kind) ? 'k-btn--danger' : 'k-btn--secondary';
  return (
    <button
      key={action.actionId}
      type="button"
      className={`k-btn ${variant} k-btn--sm`}
      data-act="inside-action"
      data-action-id={action.actionId}
      title={INSIDE_ACTION_TITLE[action.kind]}
      onClick={onClick}
    >
      {label}
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
      {x.provider ? <RuntimeIcon kind="agent" provider={x.provider} /> : null}
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
export function TokenPill({ t, live }: { readonly t: TokenUsageView | undefined; readonly live: boolean }) {
  if (!t) return null;
  if (t.state === 'unavailable') return <span className="token-stat" title={t.title}>usage unavailable</span>;
  return (
    <span className={`token-stat${live ? ' live' : ''}`} title={t.exact ? `${t.exact} fresh tokens` : undefined}>
      <span className="sigma">Σ</span>
      {`${t.total} tok`}
      {/* Cache reads ride BESIDE the headline, never inside it: context re-sent from the prompt cache is charged at a fraction of the fresh rate. */}
      {t.cacheRead ? (
        <span className="cache-read" title={`${t.cacheReadExact || t.cacheRead} tokens re-read from the prompt cache`}>
          {`+${t.cacheRead} cached`}
        </span>
      ) : null}
    </span>
  );
}
