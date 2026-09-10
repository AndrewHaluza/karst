import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'webview.html'), 'utf8');

function scriptBlock(): string {
  const start = HTML.indexOf('<script>');
  const end = HTML.indexOf('</script>');
  expect(start, '<script> not found').toBeGreaterThanOrEqual(0);
  expect(end, '</script> not found').toBeGreaterThan(start);
  return HTML.slice(start + '<script>'.length, end);
}

describe('resources webview.html', () => {
  it('keeps the CSP marker — without it the page ships with no policy', () => {
    expect(HTML).toContain('<!--KARST_CSP-->');
  });

  it('carries all three injection markers (UI-R03)', () => {
    expect(HTML).toContain('/*KARST_DS_CSS*/');
    expect(HTML).toContain('/*KARST_DS_JS*/');
    expect(HTML).toContain('/*KARST_PALETTE*/');
  });

  it('loads nothing from outside itself (UI-R02)', () => {
    expect(HTML).not.toMatch(/<script[^>]*\bsrc=/);
    expect(HTML).not.toMatch(/<link\b/i);
    expect(HTML).not.toMatch(/https?:\/\//);
  });

  it('uses no chart library and no external asset', () => {
    const script = scriptBlock();
    expect(script).not.toMatch(/chart\.js|echarts|d3|plotly|chartjs/i);
    expect(HTML).not.toMatch(/<img\b/);
  });

  it('renders the sparkline as inline SVG polylines, not an external chart', () => {
    const script = scriptBlock();
    expect(script).toContain('<polyline');
    expect(HTML).toContain('viewBox="0 0 560 80"');
    expect(script).toContain('state.history');
  });

  it('labels the two chart series with toggleable legend buttons (UI-R28)', () => {
    expect(HTML).toContain('CPU %');
    expect(HTML).toContain('RSS');
    expect(HTML).toContain('data-series="cpu"');
    expect(HTML).toContain('data-series="rss"');
    const script = scriptBlock();
    expect(script).toContain('muted[series] = on');
    expect(script).toContain('renderSpark(lastState)');
    const handler = script.slice(
      script.indexOf("for (const btn of document.querySelectorAll('.legendBtn'))"),
      script.indexOf("window.addEventListener('message'"),
    );
    expect(handler).not.toContain('post(');
  });

  it('shows scale markers: per-series maxima, y-axis gridline labels, and x-axis time ticks', () => {
    expect(HTML).toContain('id="chartScale"');
    expect(HTML).toContain('state.trend.cpuMaxDisplay');
    expect(HTML).toContain('id="chartTicks"');
    expect(HTML).toContain('state.trend.timeTicks');
    expect(HTML).toContain('CPU ${esc(state.trend.cpuMaxDisplay)}');
    expect(HTML).toContain('id="chartY"');
    expect(HTML).toContain('state.trend.yTicks');
    expect(HTML).toContain('esc(t.cpu)');
    expect(HTML).toContain('esc(t.rss)');
  });

  it('dims a muted series\'s own y-axis label, so the legend state reads on the scale too', () => {
    const script = scriptBlock();
    expect(script).toContain("`<span class=\"cpu${muted.cpu ? ' muted' : ''}\">${esc(t.cpu)}</span>`");
    expect(script).toContain("`<span class=\"rss${muted.rss ? ' muted' : ''}\">${esc(t.rss)}</span>`");
  });

  it('gives the unattributed PID column a six-character mono width (000000)', () => {
    const styles = [...HTML.matchAll(/<style>(.*?)<\/style>/gs)].map((m) => m[1]!).join('\n');
    expect(styles).toMatch(/\.utable th\.pid,\.utable td\.pid\{width:6ch\}/);
  });

  it('gives the unattributed command column the freed space and pins the numeric columns narrow', () => {
    const styles = [...HTML.matchAll(/<style>(.*?)<\/style>/gs)].map((m) => m[1]!).join('\n');
    expect(styles).toMatch(/\.utable th\.cmd,\.utable td\.cmd\{width:100%\}/);
    expect(styles).toMatch(/\.utable td\.cmd\{min-width:0;max-width:0;overflow:hidden;/);
    expect(styles).toMatch(/\.utable th\.amt,\.utable td\.amt\{width:1%;white-space:nowrap\}/);
  });

  it('renders the attributed ticket cell from the resolved key and title', () => {
    expect(HTML).toContain('class="tkey"');
    expect(HTML).toContain('r.ticketKey');
    expect(HTML).toContain('class="ttitle"');
    expect(HTML).toContain('r.ticketTitle');
  });

  it('renders the summary rail and the monitor facts lane', () => {
    expect(HTML).toContain('Proven waste');
    expect(HTML).toContain('state.wasteCount');
    expect(HTML).toContain('id="summaryMeta"');
    expect(HTML).toContain('id="facts"');
    expect(HTML).toContain('state.facts');
  });

  it('renders a relative disk share bar from the host bytes', () => {
    const script = scriptBlock();
    expect(script).toContain('Math.max(...rows.map((d) => d.bytes), 1)');
    expect(script).toContain('Math.round((d.bytes / max) * 100)');
    expect(HTML).toContain('class="diskTrack"');
  });

  it('renders cpuPct null as an em-dash, never a coerced zero', () => {
    expect(HTML).toContain('cpuPctDisplay');
  });

  it('gives the kill button the danger variant (UI-R10b)', () => {
    expect(HTML).toContain('class="k-btn k-btn--danger"');
  });

  it('explains a non-killable finding with visible copy, never a title-only explanation (UI-R19)', () => {
    expect(HTML).toContain('class="why"');
    expect(HTML).toContain('karst cannot prove this process is safe to stop');
  });

  it('shows an empty waste list as a plain line, not a table shell', () => {
    expect(HTML).toContain('nothing leaked');
  });

  it('renders an unsupported platform as a single explanatory line, no body', () => {
    expect(HTML).toContain('id="unsupported"');
    expect(HTML).toContain('classList.toggle(\'hidden\', state.supported)');
  });

  it('keeps the previous numbers on screen with a degraded note, never blanks to zeros', () => {
    expect(HTML).toContain('id="degraded"');
    expect(HTML).toContain('showing the previous numbers');
  });

  it('never formats a number itself — display strings arrive pre-rendered', () => {
    const script = scriptBlock();
    expect(script).not.toMatch(/toLocaleString\(\s*['"]en-US/);
    expect(script).not.toMatch(/\/\s*1024\b/);
  });

  it('never posts a pid or a path — only a servers.id', () => {
    expect(HTML).toContain("serverId: Number(btn.dataset.kill)");
    expect(HTML).not.toMatch(/post\(\{[^}]*\bpid:/);
    expect(HTML).not.toMatch(/post\(\{[^}]*\bpath:/);
  });

  it('renders sort controls as real buttons inside <th>, never click handlers on <th> (UI-R09)', () => {
    const script = scriptBlock();
    expect(script).not.toMatch(/<th[^>]*data-sort/);
    expect(script).toMatch(/<button type="button" class="k-btn k-btn--link" data-sort="\$\{esc\(c\.key\)\}">/);
  });

  it('sets aria-sort on the active sort column header', () => {
    const script = scriptBlock();
    expect(script).toContain('aria-sort="ascending"');
    expect(script).toContain('aria-sort="descending"');
  });

  it('appends a Unicode sort indicator to the active column label', () => {
    const script = scriptBlock();
    expect(script).toContain('\\u25B2');
    expect(script).toContain('\\u25BC');
  });

  it('cycles sort state through default → asc → desc → default', () => {
    const script = scriptBlock();
    expect(script).toContain("cur.dir === null ? 'asc' : cur.dir === 'asc' ? 'desc' : null");
  });

  it('sort is LOCAL to the webview — never posts a message', () => {
    const script = scriptBlock();
    expect(script).toContain('if (lastState) render(lastState)');
    const handlerBlock = script.slice(
      script.indexOf("btn.addEventListener('click', () => {"),
      script.indexOf("el('attrBody')"),
    );
    expect(handlerBlock).not.toContain('post(');
  });

  it('defines column definitions for both attributed and unattributed tables', () => {
    const script = scriptBlock();
    expect(script).toContain('const ATTR_COLS');
    expect(script).toContain('const UNK_COLS');
    expect(script).toContain("key: 'ticket'");
    expect(script).toContain("key: 'label'");
    expect(script).toContain("key: 'attribution'");
    expect(script).toContain("key: 'cmd'");
  });
});
