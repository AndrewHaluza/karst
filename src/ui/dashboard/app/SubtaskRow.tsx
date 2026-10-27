/**
 * One Sub-tasks row, left to right: status dot, T-id, key, title (the only cell that ellipsizes), PR chip,
 * blocker lock, agent, time, stage pill. A blocked row wraps and states its fault on a second line. The row is
 * not a control: no click action, no row-level tooltip (the title cell and the other cells carry their own).
 */
import { memo } from 'react';
import { AgentIcon } from './AgentIcon.js';
import { Icon } from './Icon.js';
import { subtaskAge } from './subtaskAge.js';

export interface SubtaskRowData {
  readonly id: number;
  readonly idLabel: string;
  readonly key: string;
  readonly title: string | null;
  readonly stage: string | null;
  readonly glyph: string;
  readonly stageClass: string;
  readonly blocking: boolean;
  readonly done: boolean;
  readonly autostart: string | null;
  readonly fault: { readonly kind: string; readonly title: string; readonly reason: string; readonly since: string } | null;
  readonly pr: { readonly number: number; readonly state: 'open' | 'merged' | 'closed'; readonly more: number } | null;
  readonly agent: { readonly core: string; readonly coreLabel: string; readonly model: string | null; readonly modelShort: string | null } | null;
  readonly stageSince: string | null;
  readonly queuePos: number | null;
}

// The status glyph a row paints: the shipped `.k-dot` primitive, recoloured per state. `gray` (no signal yet) keeps the ringless default.
const DOT: Record<string, string> = { blue: 'k-dot--running', amber: 'k-dot--attention', green: 'k-dot--passed', red: 'k-dot--failed' };

// `autostart` is host-derived (UI-R31): a sub-task waiting at scope for the autostart sweep reads "Queued", one being started "Starting".
const AUTOSTART_WORD: Record<string, string> = { queued: 'Queued', starting: 'Starting' };

function Pr({ pr }: { readonly pr: NonNullable<SubtaskRowData['pr']> }) {
  return (
    <span className={`subtask-pr subtask-pr--${pr.state}`} title={`PR #${pr.number} ${pr.state}`}>
      #{pr.number}
      <span className="subtask-pr-state"> {pr.state}</span>
      {pr.more > 0 ? ` +${pr.more}` : null}
    </span>
  );
}

function Agent({ agent }: { readonly agent: NonNullable<SubtaskRowData['agent']> }) {
  return (
    <span className="subtask-agent" title={`${agent.coreLabel} · ${agent.model ?? 'Agent default'}`}>
      <AgentIcon provider={agent.core} />
      <span className="subtask-agent-name">{agent.coreLabel}</span>
      {agent.modelShort ? <span className="subtask-agent-model"> · {agent.modelShort}</span> : null}
    </span>
  );
}

export const SubtaskRow = memo(function SubtaskRow({ s, parentKey }: { readonly s: SubtaskRowData; readonly parentKey: string }) {
  const stage = (s.autostart ? AUTOSTART_WORD[s.autostart] : undefined) || s.stage || 'none';
  const dot = DOT[s.glyph];
  const age = subtaskAge(s, Date.now());
  const title = s.title || '(untitled)';
  const fault = s.fault ? `${s.fault.title} · ${s.fault.reason}` : null;
  const cls = ['subtask', s.done ? 'subtask--done' : '', s.fault ? 'subtask--blocked' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} data-id={s.id}>
      <span className={dot ? `k-dot ${dot}` : 'k-dot'} role="img" aria-label={s.fault ? 'blocked' : s.done ? 'done' : stage} />
      <span className="k-id">{s.idLabel}</span>
      <span className="subtask-key">{s.key}</span>
      <span className="subtask-title" title={`${s.idLabel} · ${s.key} — ${title}`}>
        {title}
      </span>
      {s.pr ? <Pr pr={s.pr} /> : null}
      {s.blocking ? (
        <span className="subtask-lock" role="img" aria-label="blocker" title={`Blocker: ${parentKey} can’t leave impl until this sub-task is done`}>
          <Icon name="lock" size={12} />
        </span>
      ) : null}
      {s.agent && !s.done ? <Agent agent={s.agent} /> : null}
      {age ? (
        <span className="subtask-age" title={age.title}>
          {age.text}
        </span>
      ) : null}
      <span className={`stage ${s.stageClass}`} title={stage}>
        {stage}
      </span>
      {s.fault ? (
        <div className="subtask-fault" title={fault ?? undefined}>
          <b className="ftitle">{s.fault.title}</b>
          {' · '}
          <span className="freason">{s.fault.reason}</span>
        </div>
      ) : null}
    </div>
  );
});
