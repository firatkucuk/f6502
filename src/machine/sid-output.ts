/** Fixed-capacity ring of output samples; the oldest samples are dropped on overflow. */
export class SampleRing {
  private readonly buf: Float32Array;
  private head = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  push(v: number): void {
    const tail = (this.head + this.size) % this.capacity;
    this.buf[tail] = v;
    if (this.size < this.capacity) this.size++;
    else this.head = (this.head + 1) % this.capacity;
  }

  drain(out: Float32Array): number {
    const n = Math.min(out.length, this.size);
    for (let i = 0; i < n; i++) out[i] = this.buf[(this.head + i) % this.capacity]!;
    this.head = (this.head + n) % this.capacity;
    this.size -= n;
    return n;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }
}
