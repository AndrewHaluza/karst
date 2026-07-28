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

  render(diagnostic = ''): string {
    const decoded = Buffer.concat(this.chunks, this.retainedBytes).toString();
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
