/**
 * Minimal protobuf reader shared by the foreign Antigravity blobs: just enough
 * to walk field tags, read varints and skip fields inside nested submessages.
 * No imports, no dependencies.
 *
 * The agy conversation DB is a FOREIGN schema (see `agyConversationWatch.ts`),
 * so every walk here is defensive: an unterminated varint, an unknown wire type
 * or a truncated length simply stops the walk and yields what was read so far.
 * Nothing in this module throws on hostile bytes.
 */

/** A cursor over one protobuf buffer. */
export interface ProtoReader {
  buf: Buffer;
  pos: number;
}

export function readVarint(r: ProtoReader): number | null {
  let result = 0;
  let shift = 0;
  while (r.pos < r.buf.length) {
    const byte = r.buf[r.pos]!;
    r.pos++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
    if (shift > 35) return null; // varint too long
  }
  return null; // unterminated
}

export function readTag(r: ProtoReader): { field: number; wire: number } | null {
  if (r.pos >= r.buf.length) return null;
  const v = readVarint(r);
  if (v === null) return null;
  return { field: v >>> 3, wire: v & 7 };
}

export function skipField(r: ProtoReader, wire: number): boolean {
  switch (wire) {
    case 0: // varint
      return readVarint(r) !== null;
    case 1: // 64-bit
      r.pos += 8;
      return r.pos <= r.buf.length;
    case 2: {
      // length-delimited
      const len = readVarint(r);
      if (len === null) return false;
      r.pos += len;
      return r.pos <= r.buf.length;
    }
    case 5: // 32-bit
      r.pos += 4;
      return r.pos <= r.buf.length;
    default:
      return false; // unknown wire type — stop walking
  }
}

/** How deep a nested message is walked before its payload is left alone. */
const MAX_NESTING_DEPTH = 4;

/**
 * True when every byte of a length-delimited field reads as printable UTF-8
 * text (tab/newline/CR allowed). A nested message's tag/length bytes are almost
 * always control characters, which is what separates a string field from a
 * submessage; an invalid UTF-8 sequence reads as U+FFFD and is rejected.
 */
function isTextBytes(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const decoded = buf.toString('utf8');
  if (decoded.includes('\uFFFD')) return false;
  for (const char of decoded) {
    const code = char.codePointAt(0)!;
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Collect the UTF-8 string fields of a protobuf blob, descending into nested
 * messages (bounded depth). Length-delimited fields that are not text are
 * treated as submessages; a field that neither reads as text nor parses is
 * simply skipped. Foreign schemas therefore degrade to "fewer strings", never a
 * throw.
 */
export function collectProtoStrings(buf: Buffer, depth = 0): string[] {
  const strings: string[] = [];
  const r: ProtoReader = { buf, pos: 0 };
  while (r.pos < buf.length) {
    const tag = readTag(r);
    if (tag === null) break;
    if (tag.wire === 2) {
      const len = readVarint(r);
      if (len === null || len < 0 || r.pos + len > buf.length) break;
      const field = buf.subarray(r.pos, r.pos + len);
      r.pos += len;
      if (isTextBytes(field)) {
        strings.push(field.toString('utf8'));
      } else if (depth < MAX_NESTING_DEPTH) {
        strings.push(...collectProtoStrings(field, depth + 1));
      }
      continue;
    }
    if (!skipField(r, tag.wire)) break;
  }
  return strings;
}
