import { basename } from 'node:path';

export const DEFAULT_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

const SECRET_NAME = [
  /^\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa/i,
  /\.p12$/i,
  /^credentials/i,
];

/** True when the file name looks like a secret that must never be copied. */
export function isSecretPath(relPath: string): boolean {
  const name = basename(relPath);
  return SECRET_NAME.some((re) => re.test(name));
}

/** Reject a tree path that could escape or confuse the tree (`..`, absolute, empty segments). */
export function isSafeTreePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s !== '.git');
}
