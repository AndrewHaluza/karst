/**
 * Create-ticket API (§ create ticket from the extension). The extension's
 * localhost hook endpoint also serves `POST /tickets`, so any local process
 * that can reach it (an agent CLI via its hook channel, a script, curl) can
 * mint a ticket in this window's project.
 *
 * The HTTP surface lives here, vscode-free, so the whole flow is unit-testable:
 * parse (untrusted JSON → validated request) and persist (key derivation +
 * the SAME `createTicketFlow` the ticket form uses — one creation path, one
 * key rule). `endpoint.ts` stays a thin router over this module.
 */

import type { Store } from '../store/db.js';
import { generateTicketKey, type Ticket } from '../store/tickets.js';
import { createTicketFlow } from '../workflow/stages/create.js';

/** Fields a ticket-creation request may carry. Everything is validated. */
export interface CreateTicketRequest {
  title: string;
  description?: string;
  key?: string;
}

export type ParseCreateTicketResult =
  | { ok: true; request: CreateTicketRequest }
  | { ok: false; message: string };

/**
 * Narrow untrusted JSON to a CreateTicketRequest. The body is external input,
 * so every field is checked as an optional string before it reaches a SQL bind.
 * Unknown fields are ignored (the caller may send extras); blank description
 * and blank key are treated as absent — an absent key means "derive one from
 * the title" downstream.
 */
export function parseCreateTicketRequest(raw: unknown): ParseCreateTicketResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: 'request body must be a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  if (o.title === undefined) {
    return { ok: false, message: 'title is required' };
  }
  if (typeof o.title !== 'string') {
    return { ok: false, message: 'title must be a string' };
  }
  const title = o.title.trim();
  if (!title) return { ok: false, message: 'title is required' };
  if (o.description !== undefined && typeof o.description !== 'string') {
    return { ok: false, message: 'description must be a string' };
  }
  if (o.key !== undefined && typeof o.key !== 'string') {
    return { ok: false, message: 'key must be a string' };
  }
  const description = o.description?.trim() || undefined;
  const key = o.key?.trim() || undefined;
  return {
    ok: true,
    request: {
      title,
      ...(description ? { description } : {}),
      ...(key ? { key } : {}),
    },
  };
}

/**
 * Create (or resurrect) the ticket through `createTicketFlow` — the same path
 * the ticket form's `persistDraft` uses, so an API-created ticket is
 * byte-identical in store shape to a form-created one. A blank key is derived
 * from the title exactly once, scoped to the project.
 */
export function createTicketFromApi(
  store: Store,
  request: CreateTicketRequest,
  opts: { projectId?: number } = {},
): Ticket {
  const key =
    request.key ??
    generateTicketKey(store, { projectId: opts.projectId }, request.title);
  return createTicketFlow(store, {
    key,
    title: request.title,
    description: request.description,
    projectId: opts.projectId,
  });
}
