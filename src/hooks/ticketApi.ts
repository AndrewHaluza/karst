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
import type { IncomingMessage, ServerResponse } from 'node:http';

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

export interface TicketApiOptions {
  /** The hosting window's project (§ projects); read at call time. */
  projectId?: () => number | undefined;
  /** Fired after a ticket is created so the sidebar + dashboard refresh. */
  onTicketCreated?: (ticketId: number) => void;
}

export interface ServeCreateTicketDeps {
  store: Store;
  options?: TicketApiOptions;
  maxBodyBytes: number;
  requestTimeoutMs: number;
}

type BodyResult =
  | { kind: 'body'; body: string }
  | { kind: 'oversize' } // 413 written, request destroyed
  | { kind: 'timeout' } //  408 written, request destroyed
  | { kind: 'aborted' }; // nothing written — the peer went away

/**
 * Read the request body with the same bounds as the hook path (max bytes +
 * deadline), and the same response semantics: oversize → 413 with the request
 * destroyed, deadline → 408 with the request destroyed, abort → silence.
 * Deliberately NOT shared with the hook handler — that path's byte-identical
 * behavior is pinned by tests and must not be disturbed.
 */
function readCreateBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
  timeoutMs: number,
  resolve: (result: BodyResult) => void,
): void {
  let body = '';
  let settled = false;

  function cleanup(): void {
    clearTimeout(deadline);
    req.removeListener('data', onData);
    req.removeListener('end', onEnd);
    req.removeListener('aborted', onAborted);
    req.removeListener('error', onAborted);
  }
  function finish(result: BodyResult, destroy: boolean): void {
    if (settled) return;
    settled = true;
    cleanup();
    if (destroy) req.destroy();
    resolve(result);
  }
  const onAborted = (): void => finish({ kind: 'aborted' }, false);
  const onData = (chunk: Buffer | string): void => {
    if (settled) return;
    body += chunk.toString();
    if (body.length > maxBytes) {
      res.writeHead(413);
      res.end();
      finish({ kind: 'oversize' }, true);
    }
  };
  const onEnd = (): void => finish({ kind: 'body', body }, false);
  const deadline = setTimeout(() => {
    res.writeHead(408);
    res.end();
    finish({ kind: 'timeout' }, true);
  }, timeoutMs);

  req.on('data', onData);
  req.on('end', onEnd);
  req.on('aborted', onAborted);
  req.on('error', onAborted);
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * Serve one `POST /tickets` request. Validation failures are 400 with a
 * bounded one-line error; a successful create is 201 with the created
 * ticket's id/key/title/description. Internal errors are 500 with a generic
 * message — raw SQL/text never leaves the host.
 */
export function serveCreateTicketRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServeCreateTicketDeps,
): void {
  readCreateBody(req, res, deps.maxBodyBytes, deps.requestTimeoutMs, (result) => {
    if (result.kind !== 'body') return; // response already written / aborted

    let raw: unknown;
    try {
      raw = JSON.parse(result.body || '{}');
    } catch {
      respondJson(res, 400, { ok: false, error: 'request body is not valid JSON' });
      return;
    }
    const parsed = parseCreateTicketRequest(raw);
    if (!parsed.ok) {
      respondJson(res, 400, { ok: false, error: parsed.message });
      return;
    }

    let ticket: Ticket;
    try {
      ticket = createTicketFromApi(deps.store, parsed.request, {
        projectId: deps.options?.projectId?.(),
      });
    } catch (e) {
      respondJson(res, 500, { ok: false, error: 'failed to create the ticket' });
      return;
    }
    deps.options?.onTicketCreated?.(ticket.id);
    respondJson(res, 201, {
      ok: true,
      ticket: {
        id: ticket.id,
        key: ticket.key,
        title: ticket.title,
        description: ticket.description,
      },
    });
  });
}
