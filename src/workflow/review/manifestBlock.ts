/** The operator manifest the reviewer cannot see in the git diff (`.karst/` is git-excluded). */
export interface OperatorManifestInfo {
  path: string;
  content: string;
  /** True when the manifest sha differs from the sha recorded when the first fix round opened. */
  changed: boolean;
}

export const MANIFEST_BLOCK_MAX_CHARS = 6000;

/** Prompt lines for a changed operator manifest; empty when it did not change. */
export function buildManifestBlock(m: OperatorManifestInfo): string[] {
  if (!m.changed) return [];
  const body =
    m.content.length > MANIFEST_BLOCK_MAX_CHARS
      ? `${m.content.slice(0, MANIFEST_BLOCK_MAX_CHARS)}\n… (truncated)`
      : m.content;
  return [
    ``,
    `The operator manifest \`${m.path}\` changed since the ticket's fix rounds began.`,
    `It is outside the git diff: \`.karst/\` is git-excluded, so a change there never appears in the diff.`,
    `Do NOT report a manifest change as missing from the diff. Judge the content below instead.`,
    `Current content of the manifest:`,
    '```yaml',
    body,
    '```',
  ];
}
