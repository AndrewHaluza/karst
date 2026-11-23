/**
 * The Resources tab: the resource monitor's cost view, unchanged in content —
 * totals, trend, monitor facts, the attributed / unattributed lanes, proven
 * waste and worktree disk. Every number arrives pre-formatted from the host
 * (UI-R31); this component only lays it out.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ResourceRowView, ResourcesState, UnknownRowView, WasteRowView } from '../state.js';
import { Button } from '../../settings/app/primitives/Button.js';
import { useResourcesApp } from './ResourcesAppContext.js';
import { useHostAction } from './useHostAction.js';
import { TrendChart } from './TrendChart.js';
import { SortableTable, type Column } from './SortableTable.js';
import { VerbNote } from './serverBits.js';
import { tierFor, type LayoutTier } from '../../layout/layoutBreakpoints.js';

const ATTR_COLS: readonly Column<ResourceRowView>[] = [
  {
    key: 'ticket', label: 'Ticket', num: false,
    sortValue: (r) => (r.ticketKey || r.ticketTitle || '').toLowerCase(),
    cell: (r) =>
      r.ticketKey || r.ticketTitle ? (
        <div className="ticketCell">
          <span className="tkey">{r.ticketKey}</span>
          <span className="ttitle">{r.ticketTitle}</span>
        </div>
      ) : (
        <div className="ticketCell"><span className="baseline">shared</span></div>
      ),
  },
  { key: 'label', label: 'Repo / label', num: false, cellCls: 'ellipsis', sortValue: (r) => (r.label || '').toLowerCase(), cell: (r) => r.label || '—' },
  { key: 'pid', label: 'PID', num: true, sortValue: (r) => r.pid, cell: (r) => r.pid || '—' },
  { key: 'cpu', label: 'CPU', num: true, sortValue: (r) => r.cpuPct ?? -1, cell: (r) => r.cpuPctDisplay },
  { key: 'rss', label: 'RSS', num: true, sortValue: (r) => r.rssBytes, cell: (r) => r.rssDisplay },
  { key: 'procs', label: 'Procs', num: true, priority: 3, sortValue: (r) => r.procCount, cell: (r) => r.procCount },
  { key: 'up', label: 'Up', num: true, priority: 3, sortValue: (r) => r.uptimeMs ?? -1, cell: (r) => r.uptimeDisplay || '—' },
  {
    key: 'attribution', label: 'Attribution', num: false, priority: 3,
    sortValue: (r) => (r.attributionText ?? r.attribution).toLowerCase(),
    cell: (r) => <span className="attrib">{r.attributionText ?? r.attribution}</span>,
  },
];

const UNK_COLS: readonly Column<UnknownRowView>[] = [
  { key: 'pid', label: 'PID', num: true, cls: 'pid', sortValue: (r) => r.pid, cell: (r) => r.pid },
  { key: 'cmd', label: 'Command', num: false, cls: 'cmd', cellCls: 'ellipsis cmd', sortValue: (r) => (r.comm || '').toLowerCase(), cell: (r) => r.comm },
  { key: 'cpu', label: 'CPU', num: true, cls: 'amt', sortValue: (r) => r.cpuPct ?? -1, cell: (r) => r.cpuPctDisplay },
  { key: 'rss', label: 'RSS', num: true, cls: 'amt', sortValue: (r) => r.rssBytes ?? -1, cell: (r) => r.rssDisplay },
  { key: 'procs', label: 'Procs', num: true, cls: 'amt', priority: 3, sortValue: (r) => r.procCount, cell: (r) => r.procCount },
];

/**
 * The Resources view's width tier (@ui:RD-TIERS). The boundaries live in
 * `layoutBreakpoints.tierFor`, one source for every view; measuring here keeps
 * the rules off a raw `@container` length, which this webview's literal budget
 * forbids (UI-R04). jsdom has no ResizeObserver, so the default is the wide tier.
 */
function useTier(): { ref: React.RefObject<HTMLDivElement | null>; tier: LayoutTier } {
  const ref = useRef<HTMLDivElement>(null);
  const [tier, setTier] = useState<LayoutTier>('wide');
  // Layout effect: the tier is known before the first paint, so a narrow panel
  // never flashes the wide layout for a frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = (width: number): void => {
      if (width > 0) setTier(tierFor(width));
    };
    read(el.getBoundingClientRect().width || el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) read(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, tier };
}

function Panel({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel">
      <div className="phead">{title}{count !== undefined && <span className="count">{count}</span>}</div>
      {children}
    </div>
  );
}

function StatCard({ label, value, note, flag }: { label: string; value: string; note: string; flag?: boolean }) {
  return (
    <div className={`stat${flag ? ' flag' : ''}`}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      <div className="n">{note}</div>
    </div>
  );
}

function Stats({ state }: { state: ResourcesState }) {
  const measuring = state.history.length === 0;
  return (
    <>
      <div className="stats" id="stats">
        <StatCard label="Attributed CPU" value={state.cpuPctDisplay} note={measuring ? 'measuring' : 'of total capacity, rolling'} />
        <StatCard label="Attributed RSS" value={state.rssDisplay} note={measuring ? 'measuring' : 'resident set size'} />
        <StatCard label="Proven waste" value={String(state.wasteCount)} note={state.wasteCount === 1 ? 'finding' : 'findings'} flag={state.wasteCount > 0} />
      </div>
      <div className="summaryMeta" id="summaryMeta">
        {state.attributedRoots} attributed roots · {state.unattributedShown} unattributed shown
      </div>
    </>
  );
}

function WasteRow({ waste }: { waste: WasteRowView }) {
  const { send } = useResourcesApp().bridge;
  const kill = useHostAction<[number]>('Stop process', (requestId, serverId) => send.killServer(serverId, requestId));
  return (
    <div className="wgroup">
      <div className="wrow">
        <span className="reason" title={waste.reason}>{waste.reason}</span>
        <span className="amt">{waste.rssDisplay}</span>
        {waste.killable && waste.serverId !== null ? (
          <Button
            variant="danger"
            busy={kill.busy}
            spinning={kill.spinning}
            disabled={kill.disabled}
            onClick={() => kill.trigger(waste.serverId!)}
          >
            Stop
          </Button>
        ) : (
          <span className="why">report-only — Karst cannot prove this process is safe to stop</span>
        )}
      </div>
      <VerbNote mutation={kill} />
    </div>
  );
}

function FactRow({ fact }: { fact: ResourcesState['facts'][number] }) {
  return (
    <div className="factRow">
      <span className="factLabel">{fact.label}</span>
      <span className={`factValue${fact.label === 'Recent CPU' && fact.value === 'rising' ? ' attn' : ''}`}>{fact.value}</span>
    </div>
  );
}

function Facts({ state }: { state: ResourcesState }) {
  const declared = state.facts.filter((f) => f.primary);
  // A hand-written fixture may predate the primary flag; its first two facts stay open.
  const open = declared.length > 0 ? declared : state.facts.slice(0, 2);
  const folded = state.facts.filter((f) => !open.includes(f));
  return (
    <div className="panel">
      <div className="phead">Monitor<span className="count">window-local</span></div>
      <div className="pbody laneFacts" id="facts">
        {open.map((f) => <FactRow key={f.label} fact={f} />)}
        {folded.length > 0 && (
          <details className="factDetails">
            <summary>Monitor details</summary>
            {folded.map((f) => <FactRow key={f.label} fact={f} />)}
          </details>
        )}
      </div>
    </div>
  );
}

function Disk({ state }: { state: ResourcesState }) {
  const { send } = useResourcesApp().bridge;
  const measure = useHostAction<[]>('Measure disk', (requestId) => send.measureDisk(requestId));
  const rows = state.disk;
  // The bar is a RELATIVE share of the largest measured worktree — presentation
  // geometry derived from the bytes the host sent.
  const max = Math.max(...rows.map((d) => d.bytes), 1);
  return (
    <Panel title="Worktree disk" count={rows.length}>
      <div className="pbody">
        <div className="measure-row">
          <Button variant="secondary" busy={measure.busy} spinning={measure.spinning} disabled={measure.disabled} onClick={() => measure.trigger()}>
            Measure
          </Button>
          <span className="meta" id="diskHint">{rows.length ? 'measured on demand, cached 60 minutes' : 'measured only while this panel is open'}</span>
        </div>
        {measure.status === 'failure' && <div className="meta" role="alert">{measure.error ?? 'Measure disk failed.'}</div>}
        <div>
          {rows.map((d) => (
            <div className="drow" key={d.path}>
              <div>
                <div className="path" title={d.display}>{d.display}</div>
                <progress className="diskTrack" max={100} value={Math.round((d.bytes / max) * 100)} aria-label={`${d.display} share of the largest worktree`} />
              </div>
              <div className="amt">{d.sizeDisplay}</div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

export function ResourcesPane({ state }: { state: ResourcesState }) {
  const { ref, tier } = useTier();
  return (
    <div className="rview" ref={ref} data-tier={tier}>
      <div className="live" id="live">{`Live · ${state.sampleAgeDisplay} · 5-minute window · not persisted`}</div>
      <div id="body">
        <Stats state={state} />
        <div className="gridTop">
          <TrendChart state={state} />
          <Facts state={state} />
        </div>
        <Panel title="Attributed to Karst" count={state.rows.length}>
          {state.rows.length === 0 ? (
            <div className="k-empty">
              <div className="k-empty-title">No Karst process runs now</div>
              <div className="k-empty-hint">Start a ticket session to see its processes.</div>
            </div>
          ) : (
            <SortableTable rows={state.rows} columns={ATTR_COLS} rowKey={(r) => `${r.pid}:${r.label}:${r.ticketKey}`} ids={{ head: 'attrHead', body: 'attrBody' }} />
          )}
          {(state.vmOverhead || state.containersDegraded) && (
            <div className="pbody">
              {state.vmOverhead && (
                <div className="meta" id="vmOverhead">
                  {`VM overhead / other · CPU ${state.vmOverhead.cpuPctDisplay} · RSS ${state.vmOverhead.rssDisplay} — container VM host cost beyond the containers above; not counted in totals.`}
                </div>
              )}
              {state.containersDegraded && (
                <div className="meta" id="containersDegraded">Container stats unavailable (docker not answering) — showing the previous reading.</div>
              )}
            </div>
          )}
        </Panel>
        <Panel title="Unattributed (top 5)" count={state.unknown.length}>
          <SortableTable rows={state.unknown} columns={UNK_COLS} rowKey={(r) => String(r.pid)} tableCls="utable" ids={{ head: 'unkHead', body: 'unknownBody' }} />
          <div className="pbody">
            <div className="meta" id="unknownNote">
              {state.unknown.length
                ? 'Largest processes not tied to Karst, machine-wide — listed for awareness, never claimed.'
                : 'No unattributed heavy processes at the moment.'}
            </div>
          </div>
        </Panel>
        <Panel title="Proven waste" count={state.waste.length}>
          <div className="pbody">
            {state.waste.length === 0 ? (
              <div className="meta">nothing leaked</div>
            ) : (
              state.waste.map((w) => <WasteRow key={`${w.kind}:${w.serverId ?? w.reason}`} waste={w} />)
            )}
          </div>
        </Panel>
        <Disk state={state} />
      </div>
    </div>
  );
}
