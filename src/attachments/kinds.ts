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

export type AttachmentKind = 'image' | 'video';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov'] as const;

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

/** The media kind for `name`, or null when the extension is not whitelisted. */
export function attachmentKind(name: string): AttachmentKind | null {
  const ext = finalExtension(name);
  if (ext === null) return null;
  return KIND_BY_EXTENSION.get(ext) ?? null;
}

/**
 * The normalized extension to use in the stored filename, or null when `name`
 * is not whitelisted. Callers must treat null as a rejection, never as "use the
 * user's suffix anyway".
 */
export function attachmentExtension(name: string): string | null {
  const ext = finalExtension(name);
  if (ext === null) return null;
  return KIND_BY_EXTENSION.has(ext) ? ext : null;
}
