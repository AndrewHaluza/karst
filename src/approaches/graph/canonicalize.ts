/**
 * RFC 8785 JSON Canonicalization Scheme plus the SHA-256 fingerprint
 * (Slice 2 Task 4).
 *
 * The compiler produces an immutable canonical topology/configuration
 * document; the exact UTF-8 bytes and the fingerprint are persisted as a
 * graph revision and verified on read. This module is deterministic and
 * pure: no store, no vscode, no provider.
 *
 * RFC 8785 requirements applied here:
 * - object keys sorted by UTF-16 code-unit order;
 * - strings escape only `"`, `\`, and C0 controls (U+0000–U+001F), each
 *   control as `\uXXXX`; lone surrogates are escaped the same way so the
 *   bytes are deterministic and JSON-safe;
 * - numbers are emitted by `JSON.stringify`, which matches the RFC's
 *   shortest-round-trip requirement; all graph numbers are validated finite
 *   safe integers, so `-0`/fractions/exponents cannot occur;
 * - no whitespace between tokens.
 */

import { createHash } from 'node:crypto';

function canonicalString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') {
      out += '\\"';
    } else if (ch === '\\') {
      out += '\\\\';
    } else if (cp < 0x20 || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += '\\u' + cp.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out + '"';
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return canonicalString(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const body = keys
      .map((key) => `${canonicalString(key)}:${canonicalJson(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  throw new Error(`cannot canonicalize value of type ${typeof value}`);
}

/** SHA-256 hex fingerprint over the canonical UTF-8 bytes. */
export function canonicalFingerprint(json: string): string {
  return createHash('sha256').update(Buffer.from(json, 'utf8')).digest('hex');
}
