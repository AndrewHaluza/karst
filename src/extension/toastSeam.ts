import * as vscode from 'vscode';
import type { EventLevel } from '../store/karstEvents.js';
import type { ToastRecorder } from './ops/toastRecorder.js';

/**
 * The ONE module that calls `vscode.window.show(Information|Warning|Error)Message`
 * (a repo test bans the call elsewhere). `toast` is a person-facing outcome: it writes
 * a `karst_events` row first, then shows the message. `ask` is a question or a modal
 * that waits for a choice: it is never recorded.
 */
let recorder: ToastRecorder | undefined;

/** Bind the recorder once the store and the project exist; undefined unbinds. */
export function bindToastRecorder(next: ToastRecorder | undefined): void {
  recorder = next;
}

type Rest = readonly unknown[];
type Shown = Thenable<string | undefined>;

const SHOW: Record<EventLevel, (message: string, ...rest: Rest) => Shown> = {
  info: (m, ...r) => (vscode.window.showInformationMessage as (m: string, ...r: Rest) => Shown)(m, ...r),
  success: (m, ...r) => (vscode.window.showInformationMessage as (m: string, ...r: Rest) => Shown)(m, ...r),
  warn: (m, ...r) => (vscode.window.showWarningMessage as (m: string, ...r: Rest) => Shown)(m, ...r),
  error: (m, ...r) => (vscode.window.showErrorMessage as (m: string, ...r: Rest) => Shown)(m, ...r),
};

/** Write one row and show nothing (a routine event, @arch:NTF-00). A failed write never throws. */
export function recordOnly(level: EventLevel, message: string, ticketId?: number): void {
  const record = recorder;
  if (!record) return;
  try {
    record(level, message, ticketId);
  } catch {
    // The recorder logs its own failures; the caller must continue whatever happens.
  }
}

/** Record one row (a failed write never blocks the toast), then show the message. */
export function showToast(level: EventLevel, message: string, items: readonly string[] = [], ticketId?: number): Shown {
  recordOnly(level, message, ticketId);
  return SHOW[level](message, ...items);
}

export const toast = {
  info: (message: string, ...items: string[]): Shown => showToast('info', message, items),
  warn: (message: string, ...items: string[]): Shown => showToast('warn', message, items),
  error: (message: string, ...items: string[]): Shown => showToast('error', message, items),
};

/** Limits for a modal detail: a taller dialog pushes its buttons off the screen. */
export interface ModalDetailLimits {
  readonly maxLines: number;
  readonly maxChars: number;
}
export const MODAL_DETAIL_LIMITS: ModalDetailLimits = { maxLines: 15, maxChars: 1000 };
const MODAL_TITLE_MAX = 60;
export const MODAL_DETAIL_SCHEME = 'karst-modal-detail';

export interface BoundedDetail {
  readonly detail: string;
  readonly cut: boolean;
}

/**
 * Cut a modal detail at a line end within both limits. A cut detail ends with a line that names
 * the editor tab holding the full text; with no title the line is left out.
 */
export function boundModalDetail(detail: string, limits: ModalDetailLimits, title?: string): BoundedDetail {
  const lines = detail.split('\n');
  if (lines.length <= limits.maxLines && detail.length <= limits.maxChars) return { detail, cut: false };
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    const next = chars + line.length + 1; // the line and its line end
    if (kept.length >= limits.maxLines || next - 1 > limits.maxChars) break;
    kept.push(line);
    chars = next;
  }
  if (kept.length === 0) kept.push(lines[0]!.slice(0, limits.maxChars));
  if (title !== undefined) kept.push(`The full text is in the editor tab "${title}".`);
  return { detail: kept.join('\n'), cut: true };
}

const detailDocs = new Map<string, string>();
let detailProviderBound = false;
let detailSeq = 0;

function modalTitle(message: string): string {
  const clean = message.replace(/[\r\n/\\]+/gu, ' ').trim() || 'Details';
  return clean.length > MODAL_TITLE_MAX ? `${clean.slice(0, MODAL_TITLE_MAX - 1)}…` : clean;
}

/** Open the full text in a read-only virtual document, beside the editor, without taking focus. */
async function openFullDetail(title: string, text: string): Promise<void> {
  if (!detailProviderBound) {
    vscode.workspace.registerTextDocumentContentProvider(MODAL_DETAIL_SCHEME, {
      provideTextDocumentContent: (uri: vscode.Uri) => detailDocs.get(uri.path) ?? '',
    });
    detailProviderBound = true;
  }
  const path = `/${(detailSeq += 1)}/${title}`;
  detailDocs.set(path, text);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: MODAL_DETAIL_SCHEME, path }));
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
}

function modalOptions(rest: Rest): { readonly detail: string } | undefined {
  const first = rest[0];
  const { modal, detail } = (first ?? {}) as { modal?: unknown; detail?: unknown };
  return modal === true && typeof detail === 'string' ? { detail } : undefined;
}

async function askBounded(level: EventLevel, message: string, rest: Rest): Promise<string | undefined> {
  const options = modalOptions(rest);
  const title = modalTitle(message);
  if (!options) return SHOW[level](message, ...rest);
  const bound = boundModalDetail(options.detail, MODAL_DETAIL_LIMITS, title);
  if (!bound.cut) return SHOW[level](message, ...rest);
  let shown = bound.detail;
  try {
    await openFullDetail(title, options.detail);
  } catch {
    // The tab is a convenience; without it the modal must not name a tab that does not exist.
    shown = boundModalDetail(options.detail, MODAL_DETAIL_LIMITS).detail;
  }
  return SHOW[level](message, { ...(rest[0] as object), detail: shown }, ...rest.slice(1));
}

export const ask = {
  info: (message: string, ...rest: Rest): Shown => askBounded('info', message, rest),
  warn: (message: string, ...rest: Rest): Shown => askBounded('warn', message, rest),
  error: (message: string, ...rest: Rest): Shown => askBounded('error', message, rest),
};
