/**
 * The review-stall answer inside the blocked banner (T1001, @arch:REVIEW-STALL).
 *
 * Order: the evidence first (`stall-evidence`: rounds, blocking findings worst-first, diff size), then the
 * likely cause, the options as one radio group (`stall-options`), a collapsed "Show what changes"
 * (`stall-changes`: the note, description and acceptance check, editable there) and one primary Apply.
 * The user never has to write text. States: generating, ready (one or several options), failed
 * (Retry + Stop and ask in planning, no empty field), applying (the runtime's pending state on Apply), and
 * refused (the host's reason, inline, from the `action-result`).
 */
import { useCallback, useRef, useState } from 'react';
import type { StallOption } from '../../../model/stallSuggestion.js';
import type { StallView } from '../stateTypes.js';
import { useDashboardSend, useHostMessage } from './DashboardAppContext.js';
import { beginPending, usePendingAction } from './usePendingAction.js';
import './StallPanel.css';

/** Findings listed per round before the "+N more" line (the host sorted them worst-first). */
const ROUND_FINDINGS_SHOWN = 6;

interface Draft {
  note: string;
  description: string;
  acceptanceCheck: string;
}

const draftOf = (o: StallOption): Draft => ({ note: o.note, description: o.description ?? '', acceptanceCheck: o.acceptanceCheck ?? '' });

function Evidence({ stall }: { readonly stall: StallView }) {
  const diff = stall.diff === null ? 'Diff size unknown' : `${stall.diff.fileCount} file${stall.diff.fileCount === 1 ? '' : 's'} changed`;
  return (
    <section className="stall-evidence" data-region="stall-evidence" aria-label="Evidence">
      <p className="stall-summary">{`${stall.rounds.length} review round${stall.rounds.length === 1 ? '' : 's'} · ${diff}`}</p>
      <ol className="stall-rounds">
        {stall.rounds.map((r) => (
          <li key={r.attempt}>
            <span className="stall-round-head">{`Round ${r.attempt + 1} · ${r.findings.length} blocking`}</span>
            <ul>
              {r.findings.slice(0, ROUND_FINDINGS_SHOWN).map((f) => (
                <li key={`${f.severity}|${f.file ?? ''}|${f.line ?? ''}|${f.title}`}>
                  <span className={`stall-sev stall-sev--${f.severity}`}>{f.severity}</span>
                  {` ${f.file === null ? '' : `${f.file}${f.line === null ? '' : `:${f.line}`} — `}${f.title}`}
                </li>
              ))}
              {r.findings.length > ROUND_FINDINGS_SHOWN ? <li className="stall-more">{`+${r.findings.length - ROUND_FINDINGS_SHOWN} more`}</li> : null}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Planning({ stageKey, secondary = true }: { readonly stageKey: string; readonly secondary?: boolean }) {
  const send = useDashboardSend();
  const onClick = usePendingAction(useCallback((requestId: string) => send.stallPlanning(requestId), [send]));
  return (
    <button type="button" className={`k-btn k-btn--${secondary ? 'secondary' : 'primary'} k-btn--sm`} data-act="stall-planning" data-stagekey={stageKey} onClick={onClick}>
      Stop and ask in planning
    </button>
  );
}

function Failed({ stall, stageKey }: { readonly stall: StallView; readonly stageKey: string }) {
  const send = useDashboardSend();
  const onRetry = usePendingAction(useCallback((requestId: string) => send.stallRetry(requestId), [send]));
  return (
    <div className="stall-failed" role="status">
      <p>{stall.usageLimit === true ? 'The agent hit a usage limit, so no suggestion was written.' : 'Karst could not write a suggestion.'}</p>
      {stall.error ? <p className="stall-error">{stall.error}</p> : null}
      <div className="facts stall-actions">
        <button type="button" className="k-btn k-btn--primary k-btn--sm" data-act="stall-retry" data-stagekey={stageKey} onClick={onRetry}>
          Retry
        </button>
        <Planning stageKey={stageKey} />
      </div>
    </div>
  );
}

function Changes({ option, draft, onEdit, current }: {
  readonly option: StallOption;
  readonly draft: Draft;
  readonly onEdit: (patch: Partial<Draft>) => void;
  readonly current: StallView['current'];
}) {
  const accept = option.kind === 'accept-docs';
  return (
    <details className="stall-changes" data-region="stall-changes">
      <summary>Show what changes</summary>
      {accept ? (
        <p>{`${option.note} The ticket continues to ship. No fix round opens.`}</p>
      ) : (
        <>
          <label className="k-field">
            <span>Instruction for the fix agent</span>
            <textarea className="k-input" rows={4} value={draft.note} onChange={(e) => onEdit({ note: e.target.value })} />
          </label>
          {option.description === undefined ? (
            <p className="stall-same">The description stays as it is.</p>
          ) : (
            <label className="k-field">
              <span>Description (replaces the current text)</span>
              <textarea className="k-input" rows={4} defaultValue={undefined} value={draft.description} placeholder={current.description} onChange={(e) => onEdit({ description: e.target.value })} />
            </label>
          )}
          {option.acceptanceCheck === undefined ? (
            <p className="stall-same">The acceptance check stays as it is.</p>
          ) : (
            <label className="k-field">
              <span>Acceptance check (replaces the current text)</span>
              <textarea className="k-input" rows={4} value={draft.acceptanceCheck} placeholder={current.acceptanceCheck} onChange={(e) => onEdit({ acceptanceCheck: e.target.value })} />
            </label>
          )}
        </>
      )}
    </details>
  );
}

function Ready({ stall, stageKey }: { readonly stall: StallView; readonly stageKey: string }) {
  const send = useDashboardSend();
  const [picked, setPicked] = useState(() => Math.max(0, stall.options.findIndex((o) => o.recommended)));
  const [drafts, setDrafts] = useState<Readonly<Record<number, Draft>>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const option = stall.options[picked] ?? stall.options[0];
  useHostMessage((message) => {
    if (message.type !== 'action-result' || request.current === null || message.requestId !== request.current) return;
    request.current = null;
    setRefusal(message.ok === true ? null : (message.message ?? 'The host refused this answer.'));
  });
  const draft = option === undefined ? undefined : (drafts[picked] ?? draftOf(option));
  const edit = useCallback((patch: Partial<Draft>) => setDrafts((d) => {
    const base = stall.options[picked];
    return base === undefined ? d : { ...d, [picked]: { ...(d[picked] ?? draftOf(base)), ...patch } };
  }), [picked, stall.options]);
  if (option === undefined || draft === undefined) return <Failed stall={{ ...stall, status: 'failed', error: 'The suggestion has no options.' }} stageKey={stageKey} />;
  const blank = option.kind === 'agent' && draft.note.trim() === '';
  const onApply = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const id = beginPending(e);
    if (id === null) return;
    request.current = id;
    setRefusal(null);
    send.stallApply({
      kind: option.kind, label: option.label, note: draft.note,
      ...(option.description === undefined ? {} : { description: draft.description }),
      ...(option.acceptanceCheck === undefined ? {} : { acceptanceCheck: draft.acceptanceCheck }),
    }, id);
  };
  return (
    <>
      <p className="stall-cause">{`Likely cause: ${stall.cause ?? ''}`}</p>
      <fieldset className="stall-options" data-region="stall-options">
        <legend>Choose an answer</legend>
        {stall.options.map((o, n) => (
          <label key={o.label} className={`stall-option${n === picked ? ' is-picked' : ''}`}>
            <input type="radio" name="stall-option" checked={n === picked} onChange={() => { setPicked(n); setRefusal(null); }} />
            <span className="stall-option-label">{o.label}</span>
            {o.recommended ? <span className="stall-rec">Recommended</span> : null}
          </label>
        ))}
      </fieldset>
      <Changes option={option} draft={draft} onEdit={edit} current={stall.current} />
      {refusal === null ? null : <p className="stall-refused" role="alert">{refusal}</p>}
      <div className="facts stall-actions">
        <button type="button" className="k-btn k-btn--primary k-btn--sm" data-act="stall-apply" data-stagekey={stageKey} disabled={blank} title={blank ? 'The instruction for the fix agent is empty' : undefined} onClick={onApply}>
          Apply
        </button>
        <Planning stageKey={stageKey} />
      </div>
    </>
  );
}

export function StallPanel({ stall, stageKey }: { readonly stall: StallView | null; readonly stageKey: string }) {
  return (
    <div className="stall" data-stall-status={stall?.status ?? 'generating'}>
      {stall === null ? null : <Evidence stall={stall} />}
      {stall === null || stall.status === 'generating' ? (
        <p className="stall-generating" role="status">Karst is writing a suggestion…</p>
      ) : stall.status === 'failed' ? (
        <Failed stall={stall} stageKey={stageKey} />
      ) : (
        <Ready key={stall.parkAt} stall={stall} stageKey={stageKey} />
      )}
    </div>
  );
}
