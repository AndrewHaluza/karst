import type { DoctorReport } from './types.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const LABEL = { ok: 'OK', warn: 'Warning', fail: 'Failed' } as const;

/**
 * Static results page for the "Karst: Run Doctor" panel. Every dynamic string is
 * escaped; the page runs one inline script that posts `{type:'fix'}` back, so
 * the CSP allows only that nonce'd script.
 */
export function renderDoctorHtml(r: DoctorReport, nonce: string): string {
  const autoCount = r.checks.filter((c) => c.fix?.tier === 'auto').length;
  const rows = r.checks
    .map((c) => {
      const fix = c.fix && c.status !== 'ok'
        ? `<div class="fix">${escapeHtml(c.fix.tier)}: ${escapeHtml(c.fix.summary)} — <code>${escapeHtml(c.fix.tier === 'auto' ? 'Fix safe issues' : c.fix.tier === 'consented' ? c.fix.command : c.fix.nextStep)}</code></div>`
        : '';
      return `<li class="${c.status}"><b>${LABEL[c.status]}</b> <code>${escapeHtml(c.id)}</code> ${escapeHtml(c.detail)}${fix}</li>`;
    })
    .join('');
  const applied = r.applied
    .map((a) => `<li>${a.ok ? 'Fixed' : 'Skipped'}: ${escapeHtml(a.what)} — ${escapeHtml(a.why)} <code>${escapeHtml(a.evidence)}</code></li>`)
    .join('');
  const button = autoCount > 0 ? `<button id="fix">Fix safe issues (${autoCount})</button>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${escapeHtml(nonce)}'"><title>Karst Doctor</title></head><body><h1>Karst Doctor</h1><p>${r.summary.ok} ok, ${r.summary.warn} warn, ${r.summary.fail} fail</p>${button}<ul>${rows}</ul>${applied ? `<h2>Applied fixes</h2><ul>${applied}</ul>` : ''}<script nonce="${escapeHtml(nonce)}">const v=acquireVsCodeApi();document.getElementById('fix')?.addEventListener('click',()=>v.postMessage({type:'fix'}));</script></body></html>`;
}
