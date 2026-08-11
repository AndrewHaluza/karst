/**
 * Turn an `openStore` failure at activation into a bounded, user-facing
 * message.
 *
 * The store open is the FIRST thing `activate()` does, and the failure that
 * kills it most often is a better-sqlite3 `NODE_MODULE_VERSION` mismatch: the
 * installed addon was built for another editor's Electron (or plain Node), so
 * `new Database()` throws a raw dlopen error, activation dies, and the
 * extension host log shows an extension that is simply gone — with no hint how
 * to fix it. The modal this feeds is the remediation: the same message every
 * reader of that log gets is turned into "rebuild:electron, then reload".
 *
 * The error text is native-addon prose — unbounded — so collapse and cap it
 * before it reaches a UI surface. The ABI needle is the exact phrase the
 * addon loader prints; a missing match means some OTHER store failure and gets
 * no fix hint rather than a wrong one.
 */

const MAX_DETAIL_CHARS = 300;
const ABI_MISMATCH_RE = /NODE_MODULE_VERSION/;

export interface StoreOpenFault {
  message: string;
  fixHint?: string;
}

export function describeStoreOpenFailure(err: unknown): StoreOpenFault {
  const raw = err instanceof Error ? err.message : String(err);
  const detail = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_CHARS);
  const message =
    detail.length > 0
      ? `Karst could not open its database: ${detail}`
      : 'Karst could not open its database.';
  if (!ABI_MISMATCH_RE.test(raw)) return { message };
  return {
    message,
    fixHint:
      `The native better-sqlite3 module does not match this editor's Node ABI. ` +
      `Rebuild it from the extension install directory with "npm run rebuild:electron" ` +
      `(or reinstall with scripts/install-local.sh for this editor), then Reload Window.`,
  };
}
