import { formatTicketRef } from './entityId.js';
import { STAGE_TITLES } from './inside/types.js';

/**
 * Pure helpers for toast text (@arch:NTF-00). No `vscode` import and no store read:
 * a call site that has only an id receives a `TicketLabeler` from its binding.
 */

/** Longest ticket title in a toast, the ellipsis included. */
export const TOAST_TITLE_MAX = 40;
/** Longest reason in a toast. */
export const REASON_MAX = 200;
const ELLIPSIS = '…';
const UNKNOWN_REASON = 'unknown error';

/** Resolves a ticket id to its toast label; the binding owns the store read. */
export type TicketLabeler = (ticketId: number) => string;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/**
 * `T12 · KAR-12 "Fix login"`; `T12 "Fix login"` without a key; `T12 · KAR-12` without a
 * title. The ref is `formatTicketRef` (@arch:IDS-01); the title is cut at 40 characters.
 */
export function ticketLabel(id: number, key: string | null | undefined, title: string | null | undefined): string {
  const ref = formatTicketRef(id, key);
  const t = (title ?? '').replace(/\s+/gu, ' ').trim();
  return t ? `${ref} "${cut(t, TOAST_TITLE_MAX)}"` : ref;
}

/** First non-empty line of an error message, at most 200 characters. No stack, no JSON. */
export function reasonText(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const line = raw.split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line || /^[[{]/u.test(line)) return UNKNOWN_REASON;
  return cut(line, REASON_MAX);
}

/** `plural(1, 'repo', 'repos')` is `1 repo`; any other count uses the many form. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The toast for an implementation that finished and moved the ticket to UAT (rule 7: one text). */
export function markerAdvancedText(label: string): string {
  return `${label}: the implementation is done. The ticket moves to UAT.`;
}

/** The toast for an implementation that could not move the ticket to UAT (rule 7: one text). */
export function markerFailedText(label: string, reason: string): string {
  return `${label}: Karst could not mark the implementation as done (${reason}).`;
}

/** A stage as a toast names it (`UAT`, `Review`), never the lower-case slug (@arch:NTF-04). */
export function stageTitle(stage: string): string {
  return (STAGE_TITLES as Readonly<Record<string, string>>)[stage] ?? stage;
}

/** The toast for a server that a worktree removal could not stop (rule 7: one text). */
export function serverStillRunningText(repo: string): string {
  return `The server "${repo}" is still running in a removed worktree. Karst could not stop it. Stop it by hand.`;
}

/** One preset slot model that the catalog does not list, as the toast names it. */
export interface UnlistedPresetModel {
  /** Provider display label (`Claude`), never the provider id. */
  providerLabel: string;
  model: string;
}

/**
 * The warning for a Save that added or changed preset roles whose model the catalog does
 * not list: one text for each preset (@arch:NTF-08), no manifest key path (@arch:NTF-04).
 */
export function presetModelUnlistedText(preset: string, models: readonly UnlistedPresetModel[], roleCount: number): string {
  const roles = plural(roleCount, 'role', 'roles');
  const names =
    models.length === 1
      ? `the ${models[0]!.providerLabel} catalog has no model "${models[0]!.model}"`
      : `the catalog has no model ${models.map((m) => `"${m.model}" (${m.providerLabel})`).join(', ')}`;
  const skip = roleCount === 1 ? 'Karst skips this role' : 'Karst skips these roles';
  return `Preset "${preset}": ${names} (${roles}). ${skip} at launch. Select a model on the Agents page.`;
}
