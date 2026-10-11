import { CYCLES_PER_FRAME } from '../machine/vic';

const CYCLES_PER_SECOND = 985_248;
const MAX_FRAMES_PER_TICK = 5;
const MAX_ELAPSED_MS = 100;

export class FrameClock {
  static readonly FRAME_RATE = CYCLES_PER_SECOND / CYCLES_PER_FRAME; // 50.1245 Hz
  private last = -1;
  private acc = 0;

  advance(nowMs: number): number {
    if (this.last < 0) {
      this.last = nowMs;
      return 0;
    }
    let elapsed = nowMs - this.last;
    this.last = nowMs;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > MAX_ELAPSED_MS) elapsed = MAX_ELAPSED_MS;
    this.acc += (elapsed * FrameClock.FRAME_RATE) / 1000;
    const whole = Math.floor(this.acc);
    this.acc -= whole;
    return Math.min(whole, MAX_FRAMES_PER_TICK);
  }

  reset(): void {
    this.last = -1;
    this.acc = 0;
  }
}
