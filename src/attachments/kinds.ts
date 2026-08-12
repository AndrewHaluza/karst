/**
 * The attachment type whitelist — the single place the accepted media formats
 * are named. Ingest classifies ONCE against this and stores the result; nothing
 * downstream re-derives a kind from a filename, so a row's kind cannot drift
 * from what was actually validated.
 *
 * Classification is by the FINAL extension only. `payload.png.exe` is an `exe`,
 * not an image — matching any interior segment is how a whitelist becomes a
 * suggestion. The extension also becomes the stored filename's suffix, so the
 * accepted values are deliberately alphanumeric and separator-free.
 */

export type AttachmentKind = 'image' | 'video' | 'file';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov'] as const;

/**
 * A generic file is accepted when its extension is a plain alphanumeric suffix —
 * it becomes part of the on-disk stored name (`<hash>.<ext>`), so the charset is
 * the security boundary. Anything else (separators, whitespace, symbols, an
 * absurd length) is rejected rather than sanitized into a name that lies about
 * its contents.
 */
const SAFE_FILE_EXTENSION = /^[a-z0-9]{1,10}$/;

const KIND_BY_EXTENSION = new Map<string, AttachmentKind>([
  ...IMAGE_EXTENSIONS.map((e) => [e, 'image'] as const),
  ...VIDEO_EXTENSIONS.map((e) => [e, 'video'] as const),
]);

/**
 * The lowercase final extension of `name`, with no leading dot. Null when there
 * is none — including for a dotfile like `.png`, where the dot begins the name
 * rather than separating an extension from it.
 */
function finalExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** The media kind for `name`, or null when the extension is not accepted. */
export function attachmentKind(name: string): AttachmentKind | null {
  const ext = finalExtension(name);
  if (ext === null) return null;
  return KIND_BY_EXTENSION.get(ext) ?? (SAFE_FILE_EXTENSION.test(ext) ? 'file' : null);
}

/**
 * The normalized extension to use in the stored filename, or null when `name`
 * is not accepted. Callers must treat null as a rejection, never as "use the
 * user's suffix anyway".
 */
export function attachmentExtension(name: string): string | null {
  const ext = finalExtension(name);
  if (ext === null) return null;
  if (KIND_BY_EXTENSION.has(ext)) return ext;
  return SAFE_FILE_EXTENSION.test(ext) ? ext : null;
}
