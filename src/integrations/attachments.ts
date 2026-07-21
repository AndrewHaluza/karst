import type { BriefAttachment } from './ticketing.js';

/**
 * Attachment materialization (§15) — turns the bare `{name, url}` references a
 * provider parses out of its payload into downloaded, classified attachments the
 * brief can embed.
 *
 * Runs on the extension host with an INJECTED `fetch`, like the providers
 * themselves, so it is unit-testable with a fake and reads no secret directly:
 * the caller supplies `authFor`, which decides PER URL whether a credential is
 * sent. That per-URL decision is the point — a ClickUp attachment lives on a
 * different host than the API, and blanket-sending the API token would hand it
 * to whatever host the payload happened to name.
 *
 * A failed download is a RESULT (`kind: 'unavailable'` + `error`), never a
 * throw: one dead attachment must not cost the user the whole brief.
 */

/** Cap on inlined text. Past this the content is truncated, never dropped. */
export const MAX_EMBED_BYTES = 64 * 1024;

export interface AttachmentFetchDeps {
  fetchFn: typeof fetch;
  /**
   * Credential for a given attachment URL, or undefined to send none. Called
   * once per attachment so the caller can scope the token to its own hosts.
   */
  authFor?: (url: string) => Promise<string | undefined>;
  /** Override the embed cap (tests). Defaults to `MAX_EMBED_BYTES`. */
  maxBytes?: number;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);

const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'log', 'json', 'csv', 'tsv', 'yml', 'yaml', 'toml', 'ini',
  'xml', 'html', 'css', 'scss', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'diff',
  'patch', 'env', 'conf', 'gradle', 'properties',
]);

const TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/sql',
  'image/svg+xml',
]);

/** Lowercased extension of a URL's path (query/hash ignored) or of a filename. */
function extensionOf(nameOrUrl: string): string {
  const path = nameOrUrl.split(/[?#]/)[0] ?? '';
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/**
 * How the attachment should be embedded. MIME wins when the server sent one;
 * otherwise the extension decides — ClickUp's own file host frequently answers
 * with `application/octet-stream` for a `.md`, so extension is not a fallback
 * only for a missing header but a real classifier.
 */
export function classifyAttachment(
  name: string,
  url: string,
  mimeType: string | undefined,
): 'image' | 'text' | 'binary' {
  const mime = mimeType?.toLowerCase();
  if (mime && mime !== 'application/octet-stream') {
    if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
    if (mime.startsWith('text/') || TEXT_MIME_TYPES.has(mime)) return 'text';
    if (mime.startsWith('image/')) return 'image';
    return 'binary';
  }
  const ext = extensionOf(name) || extensionOf(url);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

function unavailable(a: BriefAttachment, error: string): BriefAttachment {
  return { ...a, kind: 'unavailable', error };
}

/** Decode at most `max` bytes as UTF-8, reporting whether anything was cut. */
function decodeCapped(bytes: Uint8Array, max: number): { text: string; truncated: boolean } {
  const truncated = bytes.byteLength > max;
  const slice = truncated ? bytes.subarray(0, max) : bytes;
  return { text: new TextDecoder().decode(slice), truncated };
}

async function materializeOne(
  a: BriefAttachment,
  deps: AttachmentFetchDeps,
): Promise<BriefAttachment> {
  const max = deps.maxBytes ?? MAX_EMBED_BYTES;
  let res: Response;
  try {
    const auth = await deps.authFor?.(a.url);
    res = await deps.fetchFn(a.url, {
      headers: auth ? { Authorization: auth } : {},
    });
  } catch (e) {
    return unavailable(a, `download failed: ${(e as Error).message}`);
  }
  if (!res.ok) return unavailable(a, `download returned ${res.status}`);

  const header = res.headers.get('content-type');
  const mimeType = header?.split(';')[0]?.trim() || a.mimeType;
  const kind = classifyAttachment(a.name, a.url, mimeType);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return unavailable(a, `read failed: ${(e as Error).message}`);
  }
  const size = bytes.byteLength;

  if (kind !== 'text') {
    // Image and binary bodies are never inlined — the brief links to them — so
    // only their metadata survives the download.
    return { ...a, kind, ...(mimeType ? { mimeType } : {}), size };
  }
  const { text, truncated } = decodeCapped(bytes, max);
  return { ...a, kind, ...(mimeType ? { mimeType } : {}), size, content: text, truncated };
}

/**
 * Download and classify every attachment. Returns NEW objects in input order;
 * the inputs are never mutated. Sequential on purpose: a ticket carries a
 * handful of attachments, and a burst of parallel requests against a provider's
 * file host is the kind of thing that earns a rate limit.
 */
export async function materializeAttachments(
  attachments: readonly BriefAttachment[],
  deps: AttachmentFetchDeps,
): Promise<BriefAttachment[]> {
  const out: BriefAttachment[] = [];
  for (const a of attachments) out.push(await materializeOne(a, deps));
  return out;
}
