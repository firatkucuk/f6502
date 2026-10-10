/** A memory-mapped chip. `peek` must have no side effects. */
export interface IoChip {
  read(reg: number): number;
  write(reg: number, value: number): void;
  peek(reg: number): number;
}
