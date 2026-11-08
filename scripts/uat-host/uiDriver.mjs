// Playwright driver for the probe's UI steps (arch:UATHOST-02). A separate Node process that run.mjs starts only for a script
// that holds a UI step. It attaches to the host's VS Code over CDP and answers one JSON line per connection on a unix socket.
// Playwright stays out of `dist`: this file is never bundled into the extension.
import { createServer } from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { diffLines, escapeRegex } from './uiScript.mjs';

const argValue = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const socketPath = argValue('--socket');
const port = Number(argValue('--port'));
const outDir = argValue('--out');
if (!socketPath || !Number.isFinite(port) || !outDir) {
  console.error('uat-ui: usage: uiDriver.mjs --socket <path> --port <cdp port> --out <dir>');
  process.exit(2);
}

const POLL_MS = 100;
const SETTLE_MS = 500;
const EARLY_ATTACH_MS = 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A step failure with a reason the tester can read; Playwright's own TimeoutError keeps its call log. */
class UiStepError extends Error {}

let workbench; // the VS Code window page
let browser;
let lastText = null; // webview text after the previous UI step: the baseline for textAdded / textRemoved

async function attach(deadline) {
  if (workbench && !workbench.isClosed()) return workbench;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: Math.max(1000, deadline - Date.now()) });
      for (const page of browser.contexts().flatMap((c) => c.pages())) {
        if (await page.locator('.monaco-workbench').count() > 0) { workbench = page; return page; }
      }
      lastErr = new Error('no VS Code workbench page yet');
    } catch (err) {
      browser = undefined;
      lastErr = err;
    }
    await sleep(POLL_MS);
  }
  throw new UiStepError(`could not attach to VS Code over CDP on port ${port}: ${lastErr?.message ?? 'unknown'}`);
}

/**
 * A webview that opened after the attach can be missing from Playwright's frame tree (the page lists an empty child frame).
 * A fresh CDP attach reads the tree again, so a missing webview surface reconnects instead of waiting for a frame that never comes.
 */
async function reattach(deadline) {
  const old = browser;
  browser = undefined;
  workbench = undefined;
  try { await old?.close(); } catch { /* a closed connection is the goal */ }
  return attach(deadline);
}
const REATTACH_AFTER_MS = 1500;

/** Leaf `vscode-webview` frames hold the panel DOM; their outer frames only hold the iframe. */
const webviewFrames = (page) =>
  page.frames().filter((f) => !f.isDetached() && f.url().startsWith('vscode-webview://') && f.childFrames().length === 0);

const scopes = (page, surface) => (surface === 'workbench' ? [page] : webviewFrames(page));

/** Per-frame reads tolerate a frame that detaches mid-read (a panel re-render); anything else surfaces. */
async function inFrames(frames, fn) {
  const out = [];
  for (const f of frames) {
    try { out.push(await f.evaluate(fn)); } catch (err) {
      if (!f.isDetached() && !/detached|closed|destroyed/i.test(String(err))) throw err;
    }
  }
  return out;
}

/** `read` reports what is on screen, so give a webview that is still loading a moment (and one reattach) before reporting none. */
async function waitForWebview(startPage, deadline) {
  let page = startPage;
  const until = Math.min(deadline, Date.now() + 2 * REATTACH_AFTER_MS + 500);
  let lastReattach = Date.now();
  while (webviewFrames(page).length === 0 && Date.now() < until) {
    if (Date.now() - lastReattach >= REATTACH_AFTER_MS) { page = await reattach(deadline); lastReattach = Date.now(); }
    await sleep(POLL_MS);
  }
  return page;
}

async function readPanel(page) {
  const frames = webviewFrames(page);
  const texts = await inFrames(frames, () => document.body?.innerText ?? '');
  const acts = await inFrames(frames, () =>
    [...document.querySelectorAll('[data-act]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      })
      .map((el) => el.getAttribute('data-act')));
  const lines = texts.flatMap((t) => t.split('\n').map((l) => l.trim()).filter(Boolean));
  return { lines, visibleActs: [...new Set(acts.flat())].sort() };
}

/**
 * First visible match of `selector`. Hidden, missing and covered targets are never forced: a hidden one waits until the
 * deadline and then fails with a not-visible reason; a covered one fails in Playwright's click with its own reason.
 */
async function findVisible(startPage, selector, surface, deadline, describe) {
  let page = startPage;
  let total = 0;
  let lastReattach = Date.now();
  for (;;) {
    if (surface === 'webview' && webviewFrames(page).length === 0 && Date.now() - lastReattach >= REATTACH_AFTER_MS && Date.now() < deadline) {
      page = await reattach(deadline);
      lastReattach = Date.now();
    }
    total = 0;
    for (const scope of scopes(page, surface)) {
      const all = scope.locator(selector);
      total += await all.count();
      const visible = all.filter({ visible: true });
      if (await visible.count() > 0) return visible.first();
    }
    if (Date.now() >= deadline) {
      throw new UiStepError(total > 0
        ? `${describe} is not visible: ${total} matching element(s), none visible`
        : `${describe} was not found on the ${surface} surface (${scopes(page, surface).length} frame(s) searched; page frames: ${JSON.stringify(page.frames().map((f) => `${f.url().slice(0, 60)}${f.isDetached() ? ' detached' : ''} children=${f.childFrames().length}`))})`);
    }
    await sleep(POLL_MS);
  }
}

const actSelector = (act) => `[data-act="${act}"]`;
const QUICK_INPUT = '.quick-input-widget .quick-input-box input';

async function quickPickRow(page, label, deadline) {
  const rows = page.locator('.quick-input-widget .quick-input-list .monaco-list-row')
    .filter({ has: page.locator('.label-name').filter({ hasText: new RegExp(`^${escapeRegex(label)}$`) }) });
  const visible = rows.filter({ visible: true });
  while (Date.now() < deadline) {
    if (await visible.count() > 0) return visible.first();
    await sleep(POLL_MS);
  }
  const shown = await page.locator('.quick-input-widget .quick-input-list .monaco-list-row .label-name').allInnerTexts();
  throw new UiStepError(`quick pick row "${label}" is not visible; visible rows: ${JSON.stringify(shown)}`);
}

/** Toasts can cover the target. Record their text, then dismiss them (arch:UATHOST-02); a failed dismiss is evidence, not silence. */
async function clearToasts(page, deadline) {
  const toasts = page.locator('.notifications-toasts .notification-toast');
  const texts = (await toasts.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let clearError;
  for (let i = 0; i < 20 && Date.now() < deadline && await toasts.count() > 0; i++) {
    try {
      const first = toasts.first();
      await first.hover({ timeout: Math.min(2000, Math.max(1, deadline - Date.now())) });
      await first.getByRole('button', { name: /clear notification/i }).first().click({ timeout: Math.min(2000, Math.max(1, deadline - Date.now())) });
    } catch (err) {
      clearError = String(err.message ?? err).split('\n')[0];
      break;
    }
  }
  return { texts, ...(clearError ? { clearError } : {}) };
}

/** Fills `evidence` in place, so what was gathered before a throw (the cleared toasts) still reaches the step file. */
async function act(page, step, deadline, evidence) {
  const remaining = () => Math.max(1, deadline - Date.now());
  switch (step.type) {
    case 'click': {
      const toasts = await clearToasts(page, deadline);
      evidence.toasts = toasts.texts;
      if (toasts.clearError) evidence.toastClearError = toasts.clearError;
      const t = step.target;
      const el = 'act' in t ? await findVisible(page, actSelector(t.act), 'webview', deadline, `[data-act="${t.act}"]`)
        : 'quickPick' in t ? await quickPickRow(page, t.quickPick, deadline)
          : await findVisible(page, t.selector, t.surface, deadline, `selector ${t.selector}`);
      await el.click({ timeout: remaining() });
      break;
    }
    case 'type': {
      const t = step.target;
      const el = 'quickInput' in t ? await findVisible(page, QUICK_INPUT, 'workbench', deadline, 'the quick input box')
        : await findVisible(page, t.selector, t.surface, deadline, `selector ${t.selector}`);
      await el.click({ timeout: remaining() });
      await page.keyboard.type(step.text);
      if (step.submit) await page.keyboard.press('Enter');
      break;
    }
    case 'press':
      await page.keyboard.press(step.key);
      break;
    case 'read':
      break;
    default:
      throw new UiStepError(`unknown UI step type "${step.type}"`);
  }
}

async function runStep({ index, step, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let status = 'pass';
  let detail;
  const extra = {};
  let page;
  try {
    page = await attach(deadline);
    if (step.type === 'read') page = await waitForWebview(page, deadline);
    lastText ??= (await readPanel(page)).lines;
    await act(page, step, deadline, extra);
  } catch (err) {
    status = err?.name === 'TimeoutError' ? 'timeout' : 'fail';
    detail = String(err?.message ?? err);
  }
  page = workbench ?? page; // a reattach inside the step replaced the page object
  // Evidence is taken for a failed step too: the screenshot shows what covered or hid the target.
  const ui = { screenshot: null, visibleActs: [], textAdded: [], textRemoved: [], ...extra };
  if (page && !page.isClosed()) {
    try {
      if (step.type !== 'read') await sleep(SETTLE_MS);
      const after = await readPanel(page);
      Object.assign(ui, { visibleActs: after.visibleActs, ...diffLines(lastText ?? [], after.lines) });
      lastText = after.lines;
      const file = `step-${String(index).padStart(3, '0')}.png`;
      await page.screenshot({ path: join(outDir, file) });
      ui.screenshot = file;
    } catch (err) {
      detail = `${detail ? `${detail}; ` : ''}evidence capture failed: ${String(err?.message ?? err).split('\n')[0]}`;
      if (status === 'pass') status = 'fail';
    }
  }
  return { status, ...(detail ? { detail } : {}), ui };
}

// Steps arrive one at a time and in order; the queue keeps a late connection from interleaving two steps.
let queue = Promise.resolve();
mkdirSync(outDir, { recursive: true });
rmSync(socketPath, { force: true });
const server = createServer((conn) => {
  conn.setEncoding('utf8');
  let buf = '';
  conn.on('data', (chunk) => {
    buf += chunk;
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    const line = buf.slice(0, nl);
    buf = '';
    queue = queue.then(async () => {
      let reply;
      try {
        reply = await runStep(JSON.parse(line));
      } catch (err) {
        reply = { status: 'fail', detail: `ui driver error: ${String(err?.message ?? err)}` };
      }
      conn.end(`${JSON.stringify(reply)}\n`);
    });
  });
  conn.on('error', () => { /* the host hung up; nothing to answer */ });
});
server.listen(socketPath, () => {
  console.log(`uat-ui: driver listening, CDP port ${port}`);
  // Attach before any webview exists: frames created while attached are tracked, a late attach can miss them.
  attach(Date.now() + EARLY_ATTACH_MS).catch((err) => console.error(`uat-ui: early attach failed — ${err.message}`));
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); process.exit(0); });
