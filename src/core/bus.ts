export interface Bus {
  /** One call is one CPU cycle. Must return 0..255. */
  read(addr: number): number;
  /** One call is one CPU cycle. */
  write(addr: number, value: number): void;
}

export interface CpuHooks {
  /** Called once per cycle, after the bus access completes. */
  onCycle?(): void;
}
