export interface Bus {
  /** One call is one CPU cycle. Must return 0..255. */
  read(addr: number): number;
  /** One call is one CPU cycle. */
  write(addr: number, value: number): void;
}

export interface CpuHooks {
  /** Called once per cycle, after the bus access completes. */
  onCycle?(): void;
  /**
   * Return false while the CPU must be held (BA low). Consulted before every bus READ;
   * writes never wait. The CPU idles one cycle (onCycle fires, interrupt lines are sampled)
   * per call that returns false.
   */
  rdy?(): boolean;
}
