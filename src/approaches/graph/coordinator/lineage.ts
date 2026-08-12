/**
 * Fork lineage and join correlation (Slice 5 Task 4).
 *
 * A fork execution is a self-loop traversal: it mints a fresh UUIDv7
 * `fork_instance_id` (the design's host-generated identity), increments the
 * INTEGER `fork_instance` — the fork's monotonic visit number and the
 * UNIQUE-index component — and extends the bounded `fork_lineage` STACK,
 * outermost first ('root:a:b'), one segment per traversal.
 *
 * Join correlation matches on the FULL stack AND the visit number
 * (`joinCorrelationKey`), so two loop iterations of one fork — which can
 * share a lineage string while differing only in visit — never correlate,
 * and neither do two forks that happen to share a visit number. The stack
 * depth is capped at the compiler's nesting bound (`GRAPH_LIMITS
 * .maxLineageDepth`); the store enforces the same bound at INSERT time.
 *
 * Host-agnostic: no vscode, no machine, no store import.
 */

/**
 * A UUIDv7: 48-bit unix-ms timestamp prefix (time-ordered), version nibble 7
 * and variant 10, then 74 bits of randomness. Implemented locally (Node's
 * `crypto.randomUUID` is v4) from the injected clock so it is deterministic
 * in tests and the host can pass the real one.
 */
export function uuidv7(now: Date = new Date()): string {
  const ms = BigInt(now.getTime());
  const rnd = new Uint8Array(10);
  crypto.getRandomValues(rnd);
  let rand = 0n;
  for (const byte of rnd) rand = (rand << 8n) | BigInt(byte);
  const randA = rand >> 68n; // top 12 bits (rand_b's 62 go below)
  const randB = rand & ((1n << 62n) - 1n);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ms >> BigInt(40 - i * 8)) & 0xffn);
  }
  bytes[6] = Number((0x7n << 4n) | (randA >> 8n));
  bytes[7] = Number(randA & 0xffn);
  bytes[8] = Number(0x80n | (randB >> 56n));
  for (let i = 0; i < 7; i++) {
    bytes[9 + i] = Number((randB >> BigInt(48 - i * 8)) & 0xffn);
  }
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The depth of a fork-lineage stack: the number of `:`-separated segments,
 * with `root` as the outermost (depth 1). NULL (no stack) reads as 0.
 */
export function lineageDepth(lineage: string | null): number {
  if (lineage === null || lineage === '') return 0;
  return lineage.split(':').length;
}

/**
 * The join correlation key: destination + the FULL lineage stack + the fork
 * visit number. Two arrivals correlate only when all three agree, so a loop
 * iteration never borrows another iteration's pair. A null lineage reads as
 * the root stack so legacy/entry tokens correlate with 'root'-lineage tokens.
 */
export function joinCorrelationKey(
  destination: string,
  forkLineage: string | null,
  forkInstance: number,
): string {
  return `${destination}\u0000${forkLineage ?? 'root'}\u0000${forkInstance}`;
}
