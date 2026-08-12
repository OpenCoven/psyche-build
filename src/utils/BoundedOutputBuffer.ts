const TRUNCATION_MARKER = Buffer.from('[stderr truncated]\n');

export class BoundedOutputBuffer {
  private buffer = Buffer.alloc(0);
  private truncated = false;

  constructor(private readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= TRUNCATION_MARKER.length) {
      throw new Error('Bounded output size must exceed the truncation marker length');
    }
  }

  append(chunk: Buffer | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined = Buffer.concat([this.buffer, incoming]);
    if (combined.length <= this.maxBytes && !this.truncated) {
      this.buffer = combined;
      return;
    }

    this.truncated = true;
    const tailBytes = this.maxBytes - TRUNCATION_MARKER.length;
    this.buffer = combined.subarray(Math.max(0, combined.length - tailBytes));
  }

  toString(): string {
    return (
      this.truncated
        ? Buffer.concat([TRUNCATION_MARKER, this.buffer])
        : this.buffer
    ).toString('utf8');
  }
}
