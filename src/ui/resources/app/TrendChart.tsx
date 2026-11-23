/**
 * The 5-minute trend: legend toggles, scale note and the plot itself.
 *
 * The plot is inline SVG in a fixed viewBox (no chart library, no external
 * asset). Axis labels are SVG `<text>` at percentage coordinates rather than
 * absolutely-positioned spans, so no element needs an inline style (R-X6).
 * Muting a series is local presentation — it posts nothing.
 */
import { useState } from 'react';
import type { ResourcesState } from '../state.js';

const W = 560;
const H = 80;
const PAD = 2;

interface Series {
  readonly cpu: boolean;
  readonly rss: boolean;
}

/** The one-sentence text alternative for the drawn trend (RS-8), from host-formatted values. */
export function trendSummary(state: ResourcesState): string {
  return `CPU ${state.cpuPctDisplay}, ${state.cpuTrend}. RSS ${state.rssDisplay}.`;
}

/** The empty-trend sentence: how many samples exist out of the ring (RS-9). */
export function trendEmptyText(state: ResourcesState): string {
  return `Measuring… (${state.history.length} of ${state.historyMax} samples)`;
}

function plot(state: ResourcesState, muted: Series) {
  const history = state.history;
  // One sample is not a line: the chart says it is still measuring (RS-9).
  if (history.length < 2) {
    return (
      <text x="50%" y="50%" textAnchor="middle" className="spark-empty">
        {trendEmptyText(state)}
      </text>
    );
  }
  const rss = history.map((s) => s.totals.rssBytes);
  const cpu = history.map((s) => s.totals.cpuPct);
  const rssMax = Math.max(...rss, 1);
  const cpuMax = Math.max(...cpu.filter((v): v is number => v !== null), 1);
  const x = (i: number): number => (history.length === 1 ? PAD : (i / (history.length - 1)) * (W - PAD * 2) + PAD);
  const y = (v: number, max: number): number => H - PAD - (v / max) * (H - PAD * 2);
  const rssPts = rss.map((v, i) => `${x(i)},${y(v, rssMax)}`).join(' ');
  const cpuPts: string[] = [];
  cpu.forEach((v, i) => {
    if (v !== null) cpuPts.push(`${x(i)},${y(v, cpuMax)}`);
  });
  return (
    <>
      {state.trend.yTicks.map((t) => {
        const gy = y(t.fraction * rssMax, rssMax);
        return <line key={`${t.fraction}:${t.rss}`} className="gridline" x1="0" y1={gy} x2={W} y2={gy} />;
      })}
      <polyline
        vectorEffect="non-scaling-stroke"
        className={`series-rss${muted.rss ? ' muted' : ''}`}
        points={rssPts}
      />
      {cpuPts.length > 0 && (
        <polyline
          vectorEffect="non-scaling-stroke"
          className={`series-cpu${muted.cpu ? ' muted' : ''}`}
          points={cpuPts.join(' ')}
        />
      )}
    </>
  );
}

export function TrendChart({ state }: { state: ResourcesState }) {
  const [muted, setMuted] = useState<Series>({ cpu: false, rss: false });
  const toggle = (series: keyof Series): void => setMuted((m) => ({ ...m, [series]: !m[series] }));
  const ticks = state.trend.timeTicks;
  const empty = state.history.length < 2;
  return (
    <div className="panel">
      <div className="phead">
        5-minute trend<span className="count">{state.history.length} / {state.historyMax} samples</span>
      </div>
      <div className="pbody">
        <div className="trendHead">
          <div className="legend">
            <button
              type="button"
              className="legendBtn"
              data-series="cpu"
              aria-pressed={!muted.cpu}
              onClick={() => toggle('cpu')}
            >
              <i className="swatch swCpu" />CPU %
            </button>
            <button
              type="button"
              className="legendBtn"
              data-series="rss"
              aria-pressed={!muted.rss}
              onClick={() => toggle('rss')}
            >
              <i className="swatch swRss" />RSS
            </button>
          </div>
          <span className="scaleNote" id="scaleNote">derived CPU · resident memory</span>
        </div>
        <p className="sr-only" id="trendSummary">{trendSummary(state)}</p>
        <div className="chartWrap">
          <svg className="plot" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {plot(state, muted)}
          </svg>
          {!empty && (
            <svg className="chartY" aria-hidden="true">
              {state.trend.yTicks.map((t) => {
                // The gridline is drawn in viewBox space; the label sits on the same
                // line, so its y% uses the SAME mapping as the gridline. `x=0` puts
                // the label inside the plot band, at its left edge (RS-8).
                const ySvg = H - PAD - t.fraction * (H - 2 * PAD);
                return (
                  <text key={`${t.fraction}:${t.rss}`} className="yTick" x="0" y={`${Math.round((ySvg / H) * 100)}%`}>
                    <tspan className={`cpu${muted.cpu ? ' muted' : ''}`}>{t.cpu}</tspan>
                    <tspan className={`rss${muted.rss ? ' muted' : ''}`} dx="8">{t.rss}</tspan>
                  </text>
                );
              })}
            </svg>
          )}
          <svg className="chartTicks" aria-hidden="true">
            {ticks.map((t, i) => (
              <text
                key={`${t.fraction}:${t.label}`}
                x={`${Math.round(t.fraction * 100)}%`}
                y="50%"
                textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
              >
                {t.label}
              </text>
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}
