/**
 * One workspace fragment of the integration patch (`git diff --binary
 * --output=<file>`), normalized for concatenation. The bytes stay verbatim:
 * no UTF-8 decode and no trim. A hunk that ends on a blank context line ends
 * in `" \n"`, and a trim that removes its space makes `git apply` report
 * "corrupt patch" (T1297). An empty fragment is skipped (`null`). A fragment
 * without a final newline gets exactly one, so the next fragment starts on
 * its own line.
 */

const NEWLINE = 0x0a;

export function normalizePatchFragment(raw: Buffer): Buffer | null {
  if (raw.byteLength === 0) return null;
  if (raw[raw.byteLength - 1] === NEWLINE) return raw;
  return Buffer.concat([raw, Buffer.from([NEWLINE])]);
}
