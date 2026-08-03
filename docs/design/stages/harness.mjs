// Renders the SHIPPED dashboard webview against fake DashboardState snapshots,
// so the narrow-width degradation is verified on the real file rather than on
// the mockup (whose class names diverged: .lane1/.act/.ph vs .lane/.go/.pips).
import { readFileSync, writeFileSync } from 'node:fs';
import { injectDesignSystem } from '../../../dist/model/designSystem.js';
import { injectPalette } from '../../../dist/model/palette.js';
import { injectProviderIdentity } from '../../../dist/model/providerIdentity.js';

const SRC = 'src/ui/dashboard/webview.html';
let html = readFileSync(SRC, 'utf8');
html = injectDesignSystem(html);
html = injectPalette(html);
html = injectProviderIdentity(html);
// CSP marker: drop it, the harness is a plain file:// page.
html = html.replace('<!--KARST_CSP-->', '');

const cell = (stageKey, status, extra = {}) => ({ stageKey, status, ...extra });
const MAIN = ['scope', 'impl', 'uat', 'review', 'ship', 'merge', 'done'];

function rail(statuses, { current, needsUser, needs, retry } = {}) {
  return {
    main: MAIN.map((k) => ({
      cell: cell(k, statuses[k] ?? 'pending', statuses[k + ':times'] ?? {}),
      current: current === k,
      needsUser: current === k && !!needsUser,
      needs: current === k && needsUser ? needs : null,
      retry: retry && retry.gate === k ? retry : null,
    })),
  };
}

const TIMES = {
  startedAt: '2026-08-02T10:00:00.000Z',
  endedAt: '2026-08-02T10:02:14.000Z',
};

const CASES = [
  {
    h: '1 · Not started',
    rail: rail({}, { current: 'scope' }),
    approach: null,
  },
  {
    h: '2 · Implementing, four declared phases, three reported',
    rail: rail({ scope: 'passed', 'scope:times': TIMES, impl: 'running' }, { current: 'impl' }),
    approach: {
      id: 'rpi',
      phases: ['describe', 'research', 'plan', 'implement'],
      reported: ['describe', 'research', 'plan'],
    },
  },
  {
    h: '3 · UAT failed — fix running, attempt 2 of 3',
    rail: rail(
      { scope: 'passed', 'scope:times': TIMES, impl: 'passed', uat: 'failed' },
      { current: 'uat', retry: { gate: 'uat', spent: 2, cap: 3, live: true, returnsTo: null } },
    ),
    approach: null,
  },
  {
    h: '4 · Review failed — the loop that lands on a different gate',
    rail: rail(
      { scope: 'passed', 'scope:times': TIMES, impl: 'passed', uat: 'passed', review: 'failed' },
      { current: 'review', retry: { gate: 'review', spent: 1, cap: 3, live: true, returnsTo: 'uat' } },
    ),
    approach: null,
  },
  {
    h: '5 · Ship — parked on you, uat’s spent meter dimmed',
    rail: rail(
      { scope: 'passed', 'scope:times': TIMES, impl: 'passed', uat: 'passed', review: 'passed', ship: 'pending' },
      {
        current: 'ship',
        needsUser: true,
        needs: { detail: 'ready to open the PRs', action: 'Confirm ship' },
        retry: { gate: 'uat', spent: 2, cap: 3, live: false, returnsTo: null },
      },
    ),
    approach: null,
  },
  {
    h: '6 · Merge — conflicted',
    rail: rail(
      { scope: 'passed', 'scope:times': TIMES, impl: 'passed', uat: 'passed', review: 'passed', ship: 'passed', merge: 'pending' },
      {
        current: 'merge',
        needsUser: true,
        needs: { detail: '2 repos no longer merge cleanly', action: 'Resolve' },
        retry: { gate: 'uat', spent: 2, cap: 3, live: false, returnsTo: null },
      },
    ),
    approach: null,
  },
  {
    h: '7 · Done',
    rail: rail(
      Object.fromEntries(MAIN.map((k) => [k, 'passed'])),
      { current: 'done', retry: { gate: 'uat', spent: 2, cap: 3, live: false, returnsTo: null } },
    ),
    approach: null,
  },
  {
    h: '8 · Narrowed uat budget — one tick, one attempt',
    rail: rail(
      { scope: 'passed', impl: 'passed', uat: 'failed' },
      { current: 'uat', retry: { gate: 'uat', spent: 1, cap: 1, live: false, returnsTo: null } },
    ),
    approach: null,
  },
];

const state = (c) => ({
  ticketId: 1,
  key: 'DEMO-1',
  title: 'demo',
  stageCurrent: c.rail.main.find((s) => s.current)?.cell.stageKey ?? null,
  agentState: null,
  agentSession: { provider: 'claude', providerLabel: 'Claude', modelId: null, modelLabel: null, canSwitch: false },
  stepper: c.rail.main.map((s) => s.cell),
  currentStage: c.rail.main.find((s) => s.current)?.cell ?? null,
  now: { text: 'Now: demo.', action: null },
  servers: [],
  hasRunnableRepos: false,
  worktrees: [],
  prs: [],
  mergeChecks: [],
  provider: null,
  sourceRef: null,
  ticketUrl: null,
  brief: null,
  rail: c.rail,
  inside: Object.fromEntries(
    [...MAIN, 'fix'].map((k) => [k, { stageKey: k, title: k, status: 'pending', ops: [], blurb: '' }]),
  ),
  approach: c.approach,
});

// One page per case: the shipped render() owns #rail wholesale, so each case
// gets its own iframe-free copy driven by a direct renderTrack call.
const harness = `
<script nonce="x">
  window.acquireVsCodeApi = () => ({ postMessage(){}, setState(){}, getState(){ return null; } });
</script>
`;

const cases = JSON.stringify(CASES.map((c) => ({ h: c.h, state: state(c) })));

const driver = `
<script nonce="x">
(function(){
  var CASES = ${cases};
  var out = document.createElement('div');
  out.id = 'harness';
  document.body.appendChild(out);
  CASES.forEach(function(c, i){
    var box = document.createElement('section');
    box.className = 'hcase';
    box.innerHTML = '<h3>' + c.h + '</h3><div class="stepper"><div class="railwrap" id="rail' + i + '"></div></div>';
    out.appendChild(box);
    // renderTrack writes into el('rail'); point it at this case's node.
    var real = document.getElementById('rail');
    var node = document.getElementById('rail' + i);
    node.id = 'rail';
    if (real) real.id = 'rail-parked';
    renderTrack(c.state.rail, c.state.approach, null);
    node.id = 'rail' + i;
    if (real) real.id = 'rail';
  });
  // Re-run the measurement for every track (place() only handles the first).
  window.placeAll = function(){
    document.querySelectorAll('.track').forEach(function(track){
      var lane = track.querySelector('.lane');
      var over = function(){ return lane.scrollWidth > lane.clientWidth + 1; };
      track.classList.remove('snug','tight','bare');
      if (!over()) return;
      track.classList.add('snug');
      if (!over()) return;
      track.classList.add('tight');
      if (over()) track.classList.add('bare');
    });
  };
  window.overflowReport = function(){
    return [...document.querySelectorAll('.track')].map(function(t, i){
      var lane = t.querySelector('.lane');
      return { i: i, step: t.className.replace('track','').trim() || 'full',
               sw: lane.scrollWidth, cw: lane.clientWidth,
               over: lane.scrollWidth > lane.clientWidth + 1 };
    });
  };
  placeAll();
  window.addEventListener('resize', placeAll);
})();
</script>
<style nonce="x">
  body{padding:16px;font-family:var(--k-font-ui)}
  .hcase{margin:0 0 18px}
  .hcase h3{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--k-text-faint);margin:0 0 6px}
</style>
`;

// The stub must be defined BEFORE the file's own script runs — appended at the
// end it lands after the acquireVsCodeApi() call that fails without it.
const firstScript = html.indexOf('<script');
html = html.slice(0, firstScript) + harness + html.slice(firstScript);
// The file has no </body> — it ends at the palette <style>. Append.
html = html + driver;
// charset must land in the first bytes: python's http.server sends text/html
// with no charset, and a meta tag further down is read too late.
writeFileSync('docs/design/stages/_harness-shipped.html', '<meta charset="utf-8">\n' + html);
console.log('wrote docs/design/stages/_harness-shipped.html');
