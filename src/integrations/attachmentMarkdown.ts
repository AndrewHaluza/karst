import type { BriefAttachment } from './ticketing.js';

/**
 * Renders materialized attachments (see `attachments.ts`) into the brief's
 * `## Attachments` section — the ONE place attachment markdown is produced, so
 * the escaping rules below hold wherever a brief is rendered.
 *
 * Everything here is untrusted: filenames and file bodies come from whoever
 * uploaded them. Two rules follow. (1) Filenames are escaped inline, never
 * emitted raw — an uploaded `foo](javascript:x)` would otherwise close karst's
 * own link and open its own. (2) Text bodies go inside a fence sized to beat
 * any fence in the content, so a file containing ``` cannot escape into the
 * brief as markup.
 *
 * URLs are printed with query and fragment STRIPPED: provider attachment links
 * are frequently pre-signed, and the signature is a credential that must not be
 * persisted into the brief (which the agent reads and may quote anywhere).
 */

/** Escape the markdown that would let a filename break out of its own line. */
export function escapeInline(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/([\\`*_[\]()<>#|~])/g, '\\$1')
    .trim();
}

/**
 * The displayable form of an attachment URL: http(s) only, query and fragment
 * removed. Anything else (a `javascript:` scheme, an unparseable string) yields
 * undefined and the attachment renders as a plain label with no link.
 */
export function safeUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return `${parsed.origin}${parsed.pathname}`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** `mime · 2.0 KB · truncated` — omitted entirely when nothing is known. */
function metaLine(a: BriefAttachment): string | undefined {
  const parts: string[] = [];
  if (a.mimeType) parts.push(escapeInline(a.mimeType));
  if (typeof a.size === 'number') parts.push(formatBytes(a.size));
  if (a.truncated) parts.push('truncated to fit the brief');
  return parts.length ? `_${parts.join(' · ')}_` : undefined;
}

/** A fence longer than any backtick run inside the content, so it can't escape. */
function fenceFor(content: string): string {
  const longest = (content.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function languageOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return /^[a-z0-9]+$/.test(ext) ? ext : '';
}

function renderOne(a: BriefAttachment): string[] {
  const label = escapeInline(a.name) || '(unnamed)';
  const href = safeUrl(a.url);
  const lines: string[] = [`### ${label}`, ''];
  const meta = metaLine(a);

  if (a.kind === 'unavailable') {
    const why = a.error ? escapeInline(a.error) : 'download failed';
    lines.push(`_Unavailable — ${why}._`);
    if (href) lines.push('', `[${label}](${href})`);
    return lines;
  }

  if (a.kind === 'image') {
    lines.push(href ? `![${label}](${href})` : `_Image ${label} (no usable link)._`);
    if (meta) lines.push('', meta);
    return lines;
  }

  if (a.kind === 'text' && typeof a.content === 'string') {
    const fence = fenceFor(a.content);
    lines.push(`${fence}${languageOf(a.name)}`, a.content, fence);
    if (meta) lines.push('', meta);
    return lines;
  }

  // Binary, or a text attachment whose body never arrived: link out.
  lines.push(href ? `[${label}](${href})` : `_${label} (no usable link)._`);
  if (meta) lines.push('', meta);
  return lines;
}

/**
 * The `## Attachments` block, as brief lines. Empty array for zero attachments —
 * a ticket without attachments must render byte-identically to before this
 * section existed.
 */
export function renderAttachmentSection(attachments: readonly BriefAttachment[]): string[] {
  if (attachments.length === 0) return [];
  const lines = ['', '## Attachments'];
  for (const a of attachments) lines.push('', ...renderOne(a));
  return lines;
}
