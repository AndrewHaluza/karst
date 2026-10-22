export const OUTPUT_TRUNCATION_MARKER = '\n[output truncated]\n';

/** Retains a byte-bounded prefix while callers continue draining the stream. */
export class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private didTruncate = false;

  constructor(private readonly maxBytes: number) {}

  get truncated(): boolean {
    return this.didTruncate;
  }

  append(chunk: Buffer): void {
    const remaining = this.maxBytes - this.retainedBytes;
    if (remaining > 0) {
      const retained = chunk.subarray(0, remaining);
      this.chunks.push(retained);
      this.retainedBytes += retained.byteLength;
    }
    if (chunk.byteLength > remaining) this.didTruncate = true;
  }

  /** Returns the retained prefix without decoding or adding a text marker. */
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.retainedBytes);
  }

  render(diagnostic = ''): string {
    const decoded = this.toBuffer().toString();
    let decodedBytes = 0;
    let decodedEnd = 0;
    for (const codePoint of decoded) {
      const codePointBytes = Buffer.byteLength(codePoint);
      if (decodedBytes + codePointBytes > this.maxBytes) break;
      decodedBytes += codePointBytes;
      decodedEnd += codePoint.length;
    }
    return `${decoded.slice(0, decodedEnd)}${
      this.didTruncate ? OUTPUT_TRUNCATION_MARKER : ''
    }${diagnostic}`;
  }
}

/** Retains the last `maxBytes` bytes, cut at a line start so no UTF-8 code point is split. */
export class TailOutput {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private didTruncate = false;

  constructor(private readonly maxBytes: number) {}

  get truncated(): boolean {
    return this.didTruncate;
  }

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalBytes += chunk.byteLength;
    while (this.chunks.length > 1 && this.totalBytes - this.chunks[0]!.byteLength >= this.maxBytes) {
      this.totalBytes -= this.chunks.shift()!.byteLength;
      this.didTruncate = true;
    }
    if (this.totalBytes > this.maxBytes) this.didTruncate = true;
  }

  render(): string {
    const all = Buffer.concat(this.chunks, this.totalBytes);
    if (all.byteLength <= this.maxBytes) return all.toString();
    const kept = all.subarray(all.byteLength - this.maxBytes);
    // Drop the partial first line; that also drops any split code point.
    const nl = kept.indexOf(0x0a);
    return (nl === -1 ? Buffer.alloc(0) : kept.subarray(nl + 1)).toString();
  }
}
