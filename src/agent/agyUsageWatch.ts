/**
 * Per-call usage extracted from one model-generate step's metadata.
 */
export interface AgyStepUsage {
  input: number;
  output: number;
  cacheRead: number;
}

/**
 * Cumulative usage for one conversation, keyed by its last contributing step idx.
 */
export interface AgyConversationUsage {
  input: number;
  output: number;
  cacheRead: number;
  /** Max `idx` among contributing steps — the monotonic event id. */
  lastStepIdx: number | null;
}

/** A row of the foreign `steps` table; only `idx` + `metadata` are read. */
export interface AgyStepRow {
  idx: number;
  metadata: Buffer | null;
}

/** Per-ticket memory of the last emitted usage event id. */
export interface AgyUsageState {
  eventId: string | null;
}

export type AgyUsageEvent = {
  kind: 'UsageUpdate';
  usage: {
    event_id: string;
    input: number;
    output: number;
    cache_read: number;
    total: number;
  };
};

// ---------------------------------------------------------------------------
// Minimal protobuf reader — just enough to walk field tags and read varints
// inside nested submessages. No imports, no dependencies.
// ---------------------------------------------------------------------------

interface ProtoReader {
  buf: Buffer;
  pos: number;
}

function readVarint(r: ProtoReader): number | null {
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

function readTag(r: ProtoReader): { field: number; wire: number } | null {
  if (r.pos >= r.buf.length) return null;
  const v = readVarint(r);
  if (v === null) return null;
  return { field: v >>> 3, wire: v & 7 };
}

function skipField(r: ProtoReader, wire: number): boolean {
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

// ---------------------------------------------------------------------------
// Protobuf walking — top-level scan for field 9, then inner walk of the
// field-9 usage submessage to collect varint fields 2, 3, 5.
// ---------------------------------------------------------------------------

/**
 * Extract per-call usage from a `steps.metadata` protobuf blob.
 *
 * The blob is a protobuf whose field 9 (wire type 2) is a length-delimited
 * submessage containing per-call token usage:
 *   field 2 = input tokens
 *   field 3 = output tokens (includes thinking)
 *   field 5 = cache-read tokens (absent when 0)
 *
 * Returns null when no field-9 submessage is found or when field 2 (input)
 * is absent within it.
 */
export function parseStepUsage(metadata: Buffer | null): AgyStepUsage | null {
  if (metadata === null || metadata.length === 0) return null;

  const r: ProtoReader = { buf: metadata, pos: 0 };

  // Scan top-level fields looking for field 9, wire type 2.
  while (r.pos < metadata.length) {
    const tag = readTag(r);
    if (tag === null) break;

    if (tag.field === 9 && tag.wire === 2) {
      // This is the usage submessage — read its length and slice.
      const len = readVarint(r);
      if (len === null || r.pos + len > metadata.length) return null;
      const sub = metadata.subarray(r.pos, r.pos + len);
      return parseUsageSubmessage(sub);
    }

    // Not the field we want — skip it.
    if (!skipField(r, tag.wire)) break;
  }

  return null;
}

function parseUsageSubmessage(buf: Buffer): AgyStepUsage | null {
  const r: ProtoReader = { buf, pos: 0 };
  let input: number | null = null;
  let output = 0;
  let cacheRead = 0;

  while (r.pos < buf.length) {
    const tag = readTag(r);
    if (tag === null) break;

    if (tag.wire === 0) {
      const val = readVarint(r);
      if (val === null) break;
      if (tag.field === 2) input = val;
      else if (tag.field === 3) output = val;
      else if (tag.field === 5) cacheRead = val;
      // All other varint fields (1, 6, 8, 9, 10, 11, …) are ignored.
      continue;
    }

    // Non-varint fields inside the submessage (length-delimited sessionID, etc.)
    if (!skipField(r, tag.wire)) break;
  }

  // Without input, this step contributes nothing.
  if (input === null) return null;

  return { input, output, cacheRead };
}

// ---------------------------------------------------------------------------
// Aggregation — sum per-call usage across all contributing steps.
// ---------------------------------------------------------------------------

/**
 * Aggregate per-call usage from all contributing steps in a conversation.
 * Steps without a field-9 submessage or without field 2 (input) are skipped.
 * Returns null when no step contributed.
 */
export function aggregateConversationUsage(
  rows: readonly AgyStepRow[],
): AgyConversationUsage | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let lastStepIdx: number | null = null;

  for (const row of rows) {
    const usage = parseStepUsage(row.metadata);
    if (usage === null) continue;
    input += usage.input;
    output += usage.output;
    cacheRead += usage.cacheRead;
    if (lastStepIdx === null || row.idx > lastStepIdx) {
      lastStepIdx = row.idx;
    }
  }

  if (lastStepIdx === null) return null;
  return { input, output, cacheRead, lastStepIdx };
}

// ---------------------------------------------------------------------------
// Watch diff — emit UsageUpdate events when the aggregate changes.
// ---------------------------------------------------------------------------

/**
 * Diff one sweep tick against the last for ONE ticket. Emits a UsageUpdate
 * event when the conversation's cumulative usage has advanced (new step idx).
 * `null` usage (no model call recorded yet) is silent.
 */
export function agyUsageTick(
  state: AgyUsageState,
  usage: AgyConversationUsage | null,
): AgyUsageEvent[] {
  if (usage === null || usage.lastStepIdx === null) return [];
  const eventId = String(usage.lastStepIdx);
  if (eventId === state.eventId) return [];
  state.eventId = eventId;
  return [
    {
      kind: 'UsageUpdate',
      usage: {
        event_id: eventId,
        input: usage.input,
        output: usage.output,
        cache_read: usage.cacheRead,
        total: usage.input + usage.output,
      },
    },
  ];
}
