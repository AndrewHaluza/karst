/**
 * The sections of an artifact's detail, with the DOM of the vanilla `artifact*Html` helpers they replaced. Detail is
 * SEMANTIC-FIRST, files LAST (spec §11): the result, the metrics, artifact-specific content, then provenance, then the
 * raw files with their explicit "Open in editor" escape into VS Code (spec §12). Opening is a host round trip through
 * `artifact-open-resource`, never automatic. Every host-posting control is runtime-pending and keeps one className.
 */
import { memo, useCallback, useState, type MouseEvent } from 'react';
import type { ArtifactSummary } from '../../../model/artifacts.js';
import type { TypedInsideAction } from '../../../model/inside/types.js';
import { OriginChip } from './ArtifactChips.js';
import { useDashboardSend, useOverlays } from './DashboardAppContext.js';
import { Icon } from './Icon.js';
import { ObjLink } from './InsideParts.js';
import { withKeys } from './insideText.js';
import { usePendingAction } from './usePendingAction.js';

type Artifact = ArtifactSummary;

export const ART_STAGE_LABEL: Readonly<Record<string, string>> = { impl: 'Implement', uat: 'UAT', review: 'Review', ship: 'Ship' };

export const Metrics = memo(function Metrics({ a }: { readonly a: Artifact }) {
  if (!a.metrics.length) return null;
  return (
    <div className="artmetrics">
      {withKeys(a.metrics, (m) => m.label).map(([key, m]) => (
        <span key={key} className="artmetric">
          <span className="am-label">{m.label}</span>
          {m.value}
        </span>
      ))}
    </div>
  );
});

const TASK_STATUS: Readonly<Record<string, { readonly cls: string; readonly word: string }>> = {
  todo: { cls: 'todo', word: 'to do' },
  doing: { cls: 'doing', word: 'in progress' },
  done: { cls: 'done', word: 'done' },
  blocked: { cls: 'blocked', word: 'blocked' },
  cancelled: { cls: 'cancelled', word: 'cancelled' },
};

/** One resource's editor-open control: the artifact id and an INDEX into its resources, never a path. */
function OpenResource({ a, index, cls, children }: { readonly a: Artifact; readonly index: number; readonly cls: string; readonly children: string }) {
  const send = useDashboardSend();
  const r = a.resources[index]!;
  const onClick = usePendingAction(useCallback((requestId: string) => send.artifactOpenResource(a.id, index, requestId), [send, a.id, index]));
  return (
    <button type="button" className={cls} data-act="artifact-open-resource" data-artifact-id={a.id} data-index={index} title={`Open ${r.label} (${r.name}) in the editor`} onClick={onClick}>
      {children}
    </button>
  );
}

/** The plan artifact's task list: each task with its current progress. The status is a coloured state named by its word only (UI-R28); the task LABEL is the visible carrier. */
export const Tasks = memo(function Tasks({ a }: { readonly a: Artifact }) {
  if (!a.tasks.length) return null;
  return (
    <section className="artsection" aria-label="Plan tasks">
      <div className="artheading">Tasks</div>
      {a.tasks.map((t) => {
        const state = TASK_STATUS[t.status] ?? TASK_STATUS.todo!;
        const own = a.resources.flatMap((r, i) => (r.taskId === t.id ? [{ r, i }] : []));
        return (
          <div key={t.id} className="arttask">
            <span className={`at-state ${state.cls}`}>
              <span className="at-dot" role="img" aria-label={state.word} />
            </span>
            <span className="at-label">{t.label}</span>
            <span className="at-kind">{`${t.kind}${t.visits ? ` · ${t.visits}` : ''}`}</span>
            {own.length ? (
              <span className="at-files">
                {own.map(({ r, i }) => (
                  <OpenResource key={r.path} a={a} index={i} cls="k-btn k-btn--secondary k-btn--sm">
                    {`${r.label} ↗`}
                  </OpenResource>
                ))}
              </span>
            ) : null}
          </div>
        );
      })}
    </section>
  );
});

const BASELINE_STATE_WORD: Readonly<Record<string, string>> = { pending: '○ Needs review', approved: '✓ Approved', rejected: '✕ Rejected' };
const BASELINE_STATUS_WORD: Readonly<Record<string, string>> = { added: 'new file', modified: 'modified', deleted: 'deleted' };

/** The UAT report only LISTS the baselines and what was decided: read-only. */
export const Baselines = memo(function Baselines({ a }: { readonly a: Artifact }) {
  if (!a.baselines?.length) return null;
  return (
    <section className="artsection" aria-label="Visual baselines">
      <div className="artheading">Visual baselines</div>
      <ul className="artfiles">
        {withKeys(a.baselines, (r) => r.path).map(([key, r]) => (
          <li key={key} className="blline">
            <span className="bl-label">{r.path}</span>
            <span className="bl-status">{BASELINE_STATUS_WORD[r.status] ?? r.status}</span>
            <span className={`blstate ${r.decision}`}>{BASELINE_STATE_WORD[r.decision] ?? r.decision}</span>
            {r.decision === 'rejected' && r.reason ? <span className="bl-status">{r.reason}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
});

/** The location of a finding: the file link when the host attached the open capability, else plain text. */
function Location({ file, line, action }: { readonly file: string; readonly line: number | null; readonly action: TypedInsideAction | undefined }) {
  const label = `${file}${line != null ? `:${line}` : ''}`;
  return action ? <ObjLink text={label} action={action} cls="file-link" title="Open this file in an editor" /> : <>{label}</>;
}

export const Findings = memo(function Findings({ a }: { readonly a: Artifact }) {
  // The repository the findings are scoped to (artifacts-local); a repository that left the findings scopes nothing.
  const [scope, setScope] = useState<string | null>(null);
  if (!a.findings.length) return null;
  const repos: string[] = [];
  for (const f of a.findings) if (f.repo && !repos.includes(f.repo)) repos.push(f.repo);
  const active = scope !== null && repos.includes(scope) ? scope : null;
  const shown = active === null ? a.findings : a.findings.filter((f) => f.repo === active);
  const chip = (label: string, value: string | null, title: string) => (
    <button key={value ?? ''} type="button" className={`sev-scope-chip${active === value ? ' active' : ''}`} data-act="artifact-findings-repo" data-repo={value ?? ''} aria-pressed={active === value ? 'true' : 'false'} title={title} onClick={() => setScope(value)}>
      {label}
    </button>
  );
  return (
    <section className="artsection" aria-label="Findings">
      <div className="artheading">Findings</div>
      {repos.length >= 2 ? (
        <div className="findings-scope art-scope" role="group" aria-label="Scope findings to one repository">
          {chip('All', null, 'Show findings from every repository')}
          {repos.map((r) => chip(r.split('/').pop() || r, r, `Show only findings recorded against ${r}`))}
        </div>
      ) : null}
      {withKeys(shown, (f) => `${f.severity}:${f.title}:${f.repo ?? ''}:${f.file ?? ''}:${f.line ?? ''}`).map(([key, f]) => (
        <div key={key} className={`artfinding ${f.severity || ''}`}>
          <div className="af-title">{`${f.severity.toUpperCase()} · ${f.title}`}</div>
          {f.detail ? <div className="af-detail">{f.detail}</div> : null}
          {f.file ? (
            <div className="af-detail">
              <Location file={f.file} line={f.line} action={f.action} />
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
});

/** The terminal button: a webview-local console entry (it posts nothing itself; the stack asks the host for the log). */
function ConsoleButton({ stage, processId, label }: { readonly stage: string; readonly processId: string | null; readonly label: string }) {
  const overlays = useOverlays();
  const onClick = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      overlays.openConsole(stage, processId);
    },
    [overlays, stage, processId],
  );
  return (
    <button type="button" className="k-iconbtn ib t-open" data-act="console" data-console={stage} data-console-proc={processId ?? undefined} aria-label={label} title={label} onClick={onClick}>
      <Icon name="terminal-2" />
    </button>
  );
}

export const Gates = memo(function Gates({ a }: { readonly a: Artifact }) {
  if (!a.gates.length) return null;
  // The console (xterm) entry: a gate stage's artifact log is previewed in the terminal "detailed mode", the same console
  // the inside gates row opens. Only the gate stages (uat/review) record a log, so only they offer it.
  const gateStage = a.stage === 'uat' || a.stage === 'review';
  return (
    <section className="artsection" aria-label="Gate runs">
      <div className="artheading">
        Gate runs
        {gateStage ? (
          <span className="sp">
            <ConsoleButton stage={a.stage} processId={null} label="View this stage's console output in the dashboard" />
          </span>
        ) : null}
      </div>
      {withKeys(a.gates, (g) => g.name).map(([key, g]) => {
        // A COLOURED STATE, not a text label: the dot carries it (UI-R28 keeps the word as its accessible name).
        const state = g.exitCode === 0 ? 'pass' : g.exitCode === null ? 'note' : 'fail';
        const word = state === 'pass' ? 'passed' : state === 'fail' ? 'failed' : 'no script';
        return (
          <div key={key} className="artgate">
            <span className={`ag-state ${state}`}>
              <span className="ag-dot" role="img" aria-label={word} />
            </span>
            <span className="ag-name">{g.name}</span>
            <span className="ag-code">{g.exitCode === null ? 'no script' : `exit ${g.exitCode}`}</span>
          </div>
        );
      })}
    </section>
  );
});

/** A repo's display name: its last path segment (trailing slash ignored). The full path stays available as the hover title. */
const repoName = (path: string): string => {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : String(path || '');
};
const Repo = ({ path }: { readonly path: string }) => (
  <span className="af-repo" title={path}>
    {repoName(path)}
  </span>
);

/** The PR number IS the open-PR control (UI-R09c): a link, with no url it stays plain text. */
function PrNumber({ url, number }: { readonly url: string | null; readonly number: number }) {
  const send = useDashboardSend();
  const post = usePendingAction(useCallback((requestId: string) => send.openPr(url ?? '', requestId), [send, url]));
  const onClick = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      post(e);
    },
    [post],
  );
  return url ? (
    <a className="obj-link pr-link" href="#" data-act="open-pr" data-url={url} title="Open this pull request on the host" onClick={onClick}>
      {`#${number}`}
    </a>
  ) : (
    <span className="pr-link">{`#${number}`}</span>
  );
}

export const Prs = memo(function Prs({ a }: { readonly a: Artifact }) {
  if (!a.prs.length) return null;
  return (
    <section className="artsection" aria-label="Pull requests">
      <div className="artheading">Pull requests</div>
      <ul className="artfiles">
        {withKeys(a.prs, (p) => `${p.repo}#${p.number ?? ''}`).map(([key, p]) => (
          <li key={key}>
            <Repo path={p.repo} />
            {p.number ? (
              <span className="af-ref">
                <PrNumber url={p.url} number={p.number} />
              </span>
            ) : null}
            {p.status ? <span className={`pr-status ${p.status}`}>{p.status}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
});

export const Commits = memo(function Commits({ a }: { readonly a: Artifact }) {
  if (!a.commits.length) return null;
  return (
    <section className="artsection" aria-label="Commits">
      <div className="artheading">Commits</div>
      <ul className="artfiles">
        {withKeys(a.commits, (c) => `${c.repo}@${c.sha}`).map(([key, c]) => (
          <li key={key}>
            {/* The commit SHA IS the open-commit control (UI-R09c): a link when the host attached the capability, plain text when not. */}
            {c.action ? <ObjLink text={c.sha.slice(0, 7)} action={c.action} cls="commit-link" title="Open this commit on the host" /> : <span className="commit-sha">{c.sha.slice(0, 7)}</span>}
            {c.message ? <span className="af-msg">{c.message}</span> : <span className="af-msg af-msg--empty">No message</span>}
            <Repo path={c.repo} />
            {c.origin === 'before-ship' ? (
              <span className="commit-origin" title="Already on the branch before ship ran">
                existing
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
});

const AGENT_CONSOLE_LABEL: Readonly<Record<string, string>> = { tester: 'Tester', review: 'Reviewer' };

/** The AI process's console entry beside the provenance that names who produced the report; availability is HOST-DERIVED (UI-R31). */
function AgentConsole({ a }: { readonly a: Artifact }) {
  const proc = a.agentConsole;
  if (!proc || (a.stage !== 'uat' && a.stage !== 'review')) return null;
  return <ConsoleButton stage={a.stage} processId={proc} label={`View the ${AGENT_CONSOLE_LABEL[proc] ?? proc}'s console output in the dashboard`} />;
}

export const Details = memo(function Details({ a }: { readonly a: Artifact }) {
  return (
    <section className="artsection" aria-label="Details">
      <div className="artheading">Details</div>
      <div className="artmeta">
        <span className="am-key">Stage</span>
        <span>{ART_STAGE_LABEL[a.stage] ?? a.stage}</span>
        <span className="am-key">Produced by</span>
        <span className="am-origin">
          <OriginChip origin={a.origin} />
          <AgentConsole a={a} />
        </span>
        <span className="am-key">Version</span>
        <span>{`${a.currentVersionLabel || ''} · ${a.freshness}`}</span>
        {a.createdAt ? (
          <>
            <span className="am-key">Created</span>
            <span>{new Date(a.createdAt).toLocaleString()}</span>
          </>
        ) : null}
      </div>
    </section>
  );
});

/** The raw files, last: a plan's own files are inline on their task, so only the artifact-level ones are listed here. */
export const Files = memo(function Files({ a }: { readonly a: Artifact }) {
  const own = a.resources.flatMap((r, i) => (r.taskId === null ? [{ r, i }] : []));
  if (!own.length) return null;
  const title = a.kind === 'plan' ? 'Plan files' : 'Underlying files';
  return (
    <section className="artsection" aria-label={title}>
      <div className="artheading">{title}</div>
      <ul className="artfiles">
        {own.map(({ r, i }) => (
          <li key={r.path}>
            <span className="af-label">{r.label}</span>
            <span className="af-name">{r.name}</span>
            <OpenResource a={a} index={i} cls="k-btn k-btn--secondary k-btn--sm">
              Open in editor ↗
            </OpenResource>
          </li>
        ))}
      </ul>
    </section>
  );
});
