import { cspMetaTag } from '../model/csp.js';
import { plural } from '../model/notifyText.js';
import { DOCTOR_AREAS, type DoctorArea, type DoctorCheck, type DoctorReport, type DoctorStatus } from './types.js';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

/** `checkedAt` may be preformatted (`HH:MM`) so a test never reads the wall clock. */
export interface DoctorPageOptions {
  /** Defaults to now. A string is used verbatim. */
  checkedAt?: Date | string;
  /** Start a rerun with focus on the page title after the report renders. */
  focusTitle?: boolean;
}

const AREA_LABEL: Readonly<Record<DoctorArea, string>> = {
  tools: 'Tools',
  manifest: 'Manifest',
  state: 'State',
  wiring: 'Wiring',
};

/** Worst-first. `ok` never appears in the problems list. */
const SEVERITY: Readonly<Record<DoctorStatus, number>> = { fail: 0, warn: 1, skipped: 2, ok: 3 };

/** The shared `.k-status` mapping (UI-R28b) — glyph + accessible name only, no visible word. */
const STATUS: Readonly<Record<DoctorStatus, { kind: string; glyph: string; label: string }>> = {
  ok: { kind: 'passed', glyph: '✓', label: 'Passed' },
  warn: { kind: 'attention', glyph: '⏸', label: 'Warning' },
  fail: { kind: 'failed', glyph: '✕', label: 'Failed' },
  skipped: { kind: 'pending', glyph: '○', label: 'Not checked' },
};

const PAGE_CSS = `*{box-sizing:border-box}
body{max-width:var(--k-content-max);margin:0 auto;padding:var(--k-space-7);background:var(--k-bg);color:var(--k-text);font-family:var(--k-font-ui);font-size:var(--k-text-base);line-height:var(--k-leading-normal)}
.k-pagehead-title:focus-visible,summary:focus-visible{outline:calc(var(--k-border-w) * 2) solid var(--k-focus);outline-offset:var(--k-space-1)}
.doc-area{margin-top:var(--k-space-7)}
.doc-area h2,.doc-applied h2,.doc-passed h2{margin:0 0 var(--k-space-3);color:var(--k-text);font-size:var(--k-text-lg);font-weight:var(--k-weight-semibold);overflow-wrap:anywhere}
.doc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--k-space-4)}
.doc-row{display:flex;gap:var(--k-space-4);align-items:flex-start;min-width:0;padding:var(--k-space-4) 0;border-bottom:var(--k-border-w) solid var(--k-border)}
.doc-row:last-child{border-bottom:0}
.doc-body{flex:1;min-width:0}
.doc-row-head{display:flex;align-items:baseline;gap:var(--k-space-3);flex-wrap:wrap;min-width:0}
.doc-title{font-weight:var(--k-weight-semibold);overflow-wrap:anywhere}
.doc-id{font-family:var(--k-font-mono);font-size:var(--k-text-xs);color:var(--k-text-dim);overflow-wrap:anywhere}
.doc-detail{margin:var(--k-space-1) 0 0;color:var(--k-text-dim);font-size:var(--k-text-sm);overflow-wrap:anywhere}
.doc-fix{margin-top:var(--k-space-3);font-size:var(--k-text-sm)}
.doc-fix-summary{margin:0}
.doc-fix-step{margin:var(--k-space-1) 0 0;color:var(--k-text-dim);overflow-wrap:anywhere}
.doc-cmd-row{display:flex;align-items:flex-start;gap:var(--k-space-3);margin-top:var(--k-space-2);min-width:0}
.k-code{font-family:var(--k-font-mono);font-size:var(--k-text-xs);background:var(--k-surface-sunken);border:var(--k-border-w) solid var(--k-border);border-radius:var(--k-radius-sm);padding:var(--k-space-2) var(--k-space-4);margin:0;white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;flex:1}
/* The Copy label slot is pinned (UI-R18): "Copied" is the visible terminal
   state and must not move the row's neighbours while it shows. */
.doc-copy{flex:none;min-width:56px}
.doc-passed{margin-top:var(--k-space-7);border-top:var(--k-border-w) solid var(--k-border);padding-top:var(--k-space-5)}
.doc-passed>summary{cursor:pointer;color:var(--k-text-dim);font-size:var(--k-text-sm);min-height:var(--k-control-h-sm);display:flex;align-items:center}
.doc-passed>summary:hover{color:var(--k-text)}
.doc-passed[open]>summary{margin-bottom:var(--k-space-4)}
.doc-applied{margin-top:var(--k-space-7)}
.doc-state{display:flex;align-items:center;gap:var(--k-space-4);color:var(--k-text-dim);font-size:var(--k-text-md)}
.doc-error{border:var(--k-border-w) solid var(--k-danger);border-radius:var(--k-radius-lg);padding:var(--k-space-5) var(--k-space-6);font-size:var(--k-text-md);overflow-wrap:anywhere}
.doc-sr{position:absolute;width:var(--k-border-w);height:var(--k-border-w);padding:0;margin:calc(var(--k-border-w) * -1);overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width: 699px){.doc-row-head{flex-direction:column;align-items:flex-start;gap:var(--k-space-1)}}
@media (max-width: 399px){.doc-cmd-row{flex-direction:column;align-items:stretch}.doc-copy{align-self:flex-start}}`;

/**
 * One self-contained document. The design system ships by marker injection
 * (UI-R03, @ui:DS-INJECTION): `/*KARST_DS_CSS*\/` sits at the top of the page's
 * own style block, `/*KARST_DS_JS*\/` is the first statement of the head script,
 * and `/*KARST_PALETTE*\/` keeps the trailing style block so the palette still
 * wins the cascade. `host.ts` calls `injectPalette(injectDesignSystem(html))`.
 *
 * All three markers live in the HEAD, before the body. Injection runs on the
 * finished document and `String.replace` rewrites the FIRST occurrence, so a
 * marker spelled inside a check's text (an escaped detail or a `data-copy`
 * command) would otherwise be where the runtime lands — host JS inside a text
 * node, or inside a quoted attribute where its quotes close the attribute.
 * With the markers ahead of every dynamic string, injection can only reach the
 * static head, and a marker in the text stays literal.
 */
function documentShell(nonce: string, body: string): string {
  const scriptNonce = escapeHtml(nonce);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${cspMetaTag(nonce)}<title>Karst Doctor</title><style>/*KARST_DS_CSS*/\n${PAGE_CSS}</style><style>/*KARST_PALETTE*/</style><script nonce="${scriptNonce}">/*KARST_DS_JS*/</script></head><body>${body}</body></html>`;
}

function statusGlyph(status: DoctorStatus): string {
  const spec = STATUS[status];
  return `<span class="k-status k-status--${spec.kind}" role="img" aria-label="${spec.label}">${spec.glyph}</span>`;
}

/** `state.server-dead.12` → `Server dead 12` when a check carries no human title. */
export function titleOf(check: DoctorCheck): string {
  if (check.title && check.title.trim().length > 0) return check.title;
  const withoutArea = check.id.replace(/^(?:tools|manifest|state|wiring)\./u, '');
  const words = withoutArea.replace(/[-_.]+/gu, ' ').trim();
  if (words.length === 0) return check.id;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The fix instruction. `tier` is internal: the page never prints it (DR-2). */
function fixBlock(check: DoctorCheck): string {
  const fix = check.fix;
  if (!fix || check.status === 'ok') return '';
  const head = `<p class="doc-fix-summary">Fix: ${escapeHtml(fix.summary)}</p>`;
  if (fix.tier === 'consented') {
    return `<div class="doc-fix">${head}<div class="doc-cmd-row"><pre class="k-code">${escapeHtml(fix.command)}</pre><button type="button" class="k-btn k-btn--secondary k-btn--sm doc-copy" data-copy="${escapeHtml(fix.command)}">Copy</button></div></div>`;
  }
  if (fix.tier === 'action') {
    // The button carries only the check id: the host reads the action from its own report and asks first (UI-R33).
    return `<div class="doc-fix">${head}<button type="button" class="k-btn k-btn--secondary k-btn--sm doc-action" data-check="${escapeHtml(check.id)}" data-label="${escapeHtml(fix.label)}">${escapeHtml(fix.label)}</button></div>`;
  }
  if (fix.tier === 'report') {
    // Prose: a next step is read, never pasted, so it is not a <code> block (DR-2).
    return `<div class="doc-fix">${head}<p class="doc-fix-step">${escapeHtml(fix.nextStep)}</p></div>`;
  }
  return `<div class="doc-fix">${head}<p class="doc-fix-step">Fixed by Fix safe issues</p></div>`;
}

function checkRow(check: DoctorCheck): string {
  return `<li class="doc-row doc-row--${check.status}">${statusGlyph(check.status)}<div class="doc-body"><div class="doc-row-head"><span class="doc-title">${escapeHtml(titleOf(check))}</span><code class="doc-id">${escapeHtml(check.id)}</code></div><p class="doc-detail">${escapeHtml(check.detail)}</p>${fixBlock(check)}</div></li>`;
}

function areaSection(area: DoctorArea, checks: readonly DoctorCheck[]): string {
  return `<section class="doc-area" data-area="${area}"><h2>${AREA_LABEL[area]}</h2><ul class="doc-list">${checks.map(checkRow).join('')}</ul></section>`;
}

function clock(checkedAt: Date | string | undefined): string {
  if (typeof checkedAt === 'string') return checkedAt;
  const at = checkedAt ?? new Date();
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function subtitle(r: DoctorReport, checkedAt: Date | string | undefined): string {
  const { ok, warn, fail, skipped } = r.summary;
  let summary: string;
  // `ok > 0` is load-bearing: without it an empty run reads "All 0 checks
  // passed" and "No checks ran" is unreachable.
  if (ok > 0 && fail === 0 && warn === 0 && skipped === 0) {
    summary = `All ${plural(ok, 'check passed', 'checks passed')}`;
  } else {
    const parts: string[] = [];
    if (fail > 0) parts.push(plural(fail, 'failed', 'failed'));
    if (warn > 0) parts.push(plural(warn, 'warning', 'warnings'));
    if (ok > 0) parts.push(plural(ok, 'passed', 'passed'));
    if (skipped > 0) parts.push(plural(skipped, 'not checked', 'not checked'));
    summary = parts.length > 0 ? parts.join(' · ') : 'No checks ran';
  }
  return `${summary} · Checked at ${clock(checkedAt)}`;
}

/** Problems first, grouped by area; a failing area sorts ahead of a warning-only one. */
function problemSections(checks: readonly DoctorCheck[]): string {
  const groups = DOCTOR_AREAS.map((area, index) => ({
    area,
    index,
    checks: checks
      .filter((c) => c.area === area)
      .map((c, order) => ({ c, order }))
      .sort((a, b) => SEVERITY[a.c.status] - SEVERITY[b.c.status] || a.order - b.order)
      .map(({ c }) => c),
  })).filter((g) => g.checks.length > 0);
  const worst = (g: (typeof groups)[number]): number => SEVERITY[g.checks[0]!.status];
  groups.sort((a, b) => worst(a) - worst(b) || a.index - b.index);
  return groups.map((g) => areaSection(g.area, g.checks)).join('');
}

/** Passed checks fold away, still under their area heading (DR-6). */
function passedDetails(checks: readonly DoctorCheck[]): string {
  if (checks.length === 0) return '';
  const sections = DOCTOR_AREAS.map((area) => ({ area, checks: checks.filter((c) => c.area === area) }))
    .filter((g) => g.checks.length > 0)
    .map((g) => areaSection(g.area, g.checks))
    .join('');
  return `<details class="doc-passed"><summary>${plural(checks.length, 'check passed', 'checks passed')}</summary>${sections}</details>`;
}

function appliedSection(r: DoctorReport): string {
  if (r.applied.length === 0) return '';
  const rows = r.applied
    .map((a) => {
      const glyph = a.ok
        ? `<span class="k-status k-status--passed" role="img" aria-label="Passed">✓</span>`
        : `<span class="k-status k-status--pending" role="img" aria-label="Pending">○</span>`;
      return `<li class="doc-row doc-row--applied">${glyph}<div class="doc-body"><p class="doc-detail">${a.ok ? 'Fixed' : 'Skipped'}: ${escapeHtml(a.what)} — ${escapeHtml(a.why)}</p><code class="doc-id">${escapeHtml(a.evidence)}</code></div></li>`;
    })
    .join('');
  return `<section class="doc-applied"><h2>Applied fixes</h2><ul class="doc-list">${rows}</ul></section>`;
}

const RUN_SCRIPT = `const v = acquireVsCodeApi();
const fix = document.getElementById('fix');
const rerun = document.getElementById('rerun');
const status = document.getElementById('fix-status');
const copyStatus = document.getElementById('copy-status');
let lastCopy = null;
let lastAction = null;
if (rerun) {
  rerun.addEventListener('click', () => {
    rerun.disabled = true;
    rerun.setAttribute('aria-busy', 'true');
    v.postMessage({ type: 'rerun' });
  });
}
if (fix) {
  fix.addEventListener('click', () => {
    fix.disabled = true;
    fix.setAttribute('aria-busy', 'true');
    fix.textContent = 'Fixing…';
    if (status) status.textContent = 'Applying fixes…';
    v.postMessage({ type: 'fix' });
  });
}
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'fix-cancelled') {
    if (fix) {
      fix.disabled = false;
      fix.removeAttribute('aria-busy');
      if (fix.dataset.label) fix.textContent = fix.dataset.label;
      fix.focus();
    }
    // A rerun clicked while the confirmation was open was dropped by the
    // busy guard, so its button is still disabled: hand it back too.
    if (rerun) {
      rerun.disabled = false;
      rerun.removeAttribute('aria-busy');
    }
    if (status) status.textContent = '';
  }
  if (e.data && e.data.type === 'action-cancelled') {
    // A cancelled or refused action hands every action button back.
    for (const button of document.querySelectorAll('.doc-action')) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
    if (lastAction) lastAction.focus();
    lastAction = null;
  }
  if (e.data && e.data.type === 'copy-done') {
    const copied = lastCopy;
    lastCopy = null;
    if (copied) {
      copied.textContent = 'Copied';
      clearTimeout(copied.copyTimer);
      copied.copyTimer = setTimeout(() => {
        copied.textContent = 'Copy';
      }, 2000);
    }
    if (copyStatus) {
      // Clear now, write on the next task: a same-tick clear-and-set is one
      // mutation, so a second Copy click would announce nothing.
      copyStatus.textContent = '';
      setTimeout(() => {
        copyStatus.textContent = 'Copied to clipboard';
      }, 0);
    }
  }
});
for (const button of document.querySelectorAll('.doc-copy')) {
  button.addEventListener('click', () => {
    lastCopy = button;
    v.postMessage({ type: 'copy', text: button.dataset.copy || '' });
  });
}
for (const button of document.querySelectorAll('.doc-action')) {
  button.addEventListener('click', () => {
    lastAction = button;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    v.postMessage({ type: 'action', id: button.dataset.check || '' });
  });
}`;

const RERUN_SCRIPT = `const v = acquireVsCodeApi();
const rerun = document.getElementById('rerun');
if (rerun) {
  rerun.addEventListener('click', () => {
    rerun.disabled = true;
    rerun.setAttribute('aria-busy', 'true');
    v.postMessage({ type: 'rerun' });
  });
}`;

/**
 * The results page: problems first (worst-first, grouped by area), then the
 * passed checks folded away, then what the last fix run did. Every dynamic
 * string is escaped; the one inline script is nonce'd.
 */
export function renderDoctorHtml(r: DoctorReport, nonce: string, opts?: DoctorPageOptions): string {
  const problems = r.checks.filter((c) => c.status !== 'ok');
  const okChecks = r.checks.filter((c) => c.status === 'ok');
  const autoCount = r.checks.filter((c) => c.status !== 'ok' && c.fix?.tier === 'auto').length;
  const fixButton =
    autoCount > 0
      ? `<button type="button" id="fix" class="k-btn k-btn--primary" data-label="Fix safe issues (${autoCount})">Fix safe issues (${autoCount})</button>`
      : '';
  const focus = r.fixRequested || opts?.focusTitle === true;
  const body = `<main><header class="k-pagehead"><div class="k-pagehead-main"><div><h1 class="k-pagehead-title" tabindex="-1">Karst Doctor</h1><p class="k-pagehead-sub">${escapeHtml(subtitle(r, opts?.checkedAt))}</p></div></div><div class="k-pagehead-actions"><button type="button" id="rerun" class="k-btn k-btn--secondary">Run again</button>${fixButton}<span id="fix-status" class="doc-sr" role="status"></span></div></header>${problemSections(problems)}${passedDetails(okChecks)}${appliedSection(r)}<span id="copy-status" class="doc-sr" role="status"></span></main><script nonce="${escapeHtml(nonce)}">${RUN_SCRIPT}${focus ? "\ndocument.querySelector('.k-pagehead-title')?.focus();" : ''}</script>`;
  return documentShell(nonce, body);
}

/** While the checks run: the page header stays, the body reports work in progress (DR-4). */
export function doctorLoadingHtml(nonce: string): string {
  const body = `<main><header class="k-pagehead"><div class="k-pagehead-main"><div><h1 class="k-pagehead-title" tabindex="-1">Karst Doctor</h1></div></div></header><div class="doc-state" role="status"><span class="k-spinner" aria-hidden="true"></span><span>Running checks…</span></div></main><script nonce="${escapeHtml(nonce)}">const v = acquireVsCodeApi();</script>`;
  return documentShell(nonce, body);
}

/** A failed run keeps the panel, states the reason, and offers the retry (DR-4). */
export function doctorErrorHtml(reason: string, nonce: string): string {
  const body = `<main><header class="k-pagehead"><div class="k-pagehead-main"><div><h1 class="k-pagehead-title" tabindex="-1">Karst Doctor</h1></div></div><div class="k-pagehead-actions"><button type="button" id="rerun" class="k-btn k-btn--secondary">Run again</button></div></header><div class="doc-error" role="alert">Karst could not run the checks: ${escapeHtml(reason)}.</div></main><script nonce="${escapeHtml(nonce)}">${RERUN_SCRIPT}</script>`;
  return documentShell(nonce, body);
}
