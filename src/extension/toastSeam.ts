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

/** Record one row (a failed write never blocks the toast), then show the message. */
export function showToast(level: EventLevel, message: string, items: readonly string[] = [], ticketId?: number): Shown {
  const record = recorder;
  if (record) {
    try {
      record(level, message, ticketId);
    } catch {
      // The recorder logs its own failures; a toast must show whatever happens.
    }
  }
  return SHOW[level](message, ...items);
}

export const toast = {
  info: (message: string, ...items: string[]): Shown => showToast('info', message, items),
  warn: (message: string, ...items: string[]): Shown => showToast('warn', message, items),
  error: (message: string, ...items: string[]): Shown => showToast('error', message, items),
};

export const ask = {
  info: (message: string, ...rest: Rest): Shown => SHOW.info(message, ...rest),
  warn: (message: string, ...rest: Rest): Shown => SHOW.warn(message, ...rest),
  error: (message: string, ...rest: Rest): Shown => SHOW.error(message, ...rest),
};
