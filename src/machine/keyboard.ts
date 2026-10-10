export type C64Key =
  | 'DEL'
  | 'RETURN'
  | 'CRSR_RIGHT'
  | 'F7'
  | 'F1'
  | 'F3'
  | 'F5'
  | 'CRSR_DOWN'
  | '3'
  | 'W'
  | 'A'
  | '4'
  | 'Z'
  | 'S'
  | 'E'
  | 'LSHIFT'
  | '5'
  | 'R'
  | 'D'
  | '6'
  | 'C'
  | 'F'
  | 'T'
  | 'X'
  | '7'
  | 'Y'
  | 'G'
  | '8'
  | 'B'
  | 'H'
  | 'U'
  | 'V'
  | '9'
  | 'I'
  | 'J'
  | '0'
  | 'M'
  | 'K'
  | 'O'
  | 'N'
  | 'PLUS'
  | 'P'
  | 'L'
  | 'MINUS'
  | 'PERIOD'
  | 'COLON'
  | 'AT'
  | 'COMMA'
  | 'POUND'
  | 'ASTERISK'
  | 'SEMICOLON'
  | 'HOME'
  | 'RSHIFT'
  | 'EQUALS'
  | 'UP_ARROW'
  | 'SLASH'
  | '1'
  | 'LEFT_ARROW'
  | 'CTRL'
  | '2'
  | 'SPACE'
  | 'COMMODORE'
  | 'Q'
  | 'RUN_STOP';

// MATRIX[col][row]: col = PA bit, row = PB bit.
// prettier-ignore
const MATRIX: readonly (readonly C64Key[])[] = [
  ['DEL', 'RETURN', 'CRSR_RIGHT', 'F7', 'F1', 'F3', 'F5', 'CRSR_DOWN'],
  ['3', 'W', 'A', '4', 'Z', 'S', 'E', 'LSHIFT'],
  ['5', 'R', 'D', '6', 'C', 'F', 'T', 'X'],
  ['7', 'Y', 'G', '8', 'B', 'H', 'U', 'V'],
  ['9', 'I', 'J', '0', 'M', 'K', 'O', 'N'],
  ['PLUS', 'P', 'L', 'MINUS', 'PERIOD', 'COLON', 'AT', 'COMMA'],
  ['POUND', 'ASTERISK', 'SEMICOLON', 'HOME', 'RSHIFT', 'EQUALS', 'UP_ARROW', 'SLASH'],
  ['1', 'LEFT_ARROW', 'CTRL', '2', 'SPACE', 'COMMODORE', 'Q', 'RUN_STOP'],
];

export const KEY_POSITION: Record<C64Key, { col: number; row: number }> = (() => {
  const out = {} as Record<C64Key, { col: number; row: number }>;
  MATRIX.forEach((rows, col) => rows.forEach((key, row) => (out[key] = { col, row })));
  return out;
})();

export class Keyboard {
  private readonly counts = new Uint8Array(64);
  /** Per column: bitmask of pressed rows. */
  private readonly rows = new Uint8Array(8);

  press(key: C64Key): void {
    const { col, row } = KEY_POSITION[key];
    const i = col * 8 + row;
    this.counts[i] = Math.min(255, this.counts[i]! + 1);
    this.rows[col]! |= 1 << row;
  }

  release(key: C64Key): void {
    const { col, row } = KEY_POSITION[key];
    const i = col * 8 + row;
    if (this.counts[i] === 0) return;
    this.counts[i]!--;
    if (this.counts[i] === 0) this.rows[col]! &= ~(1 << row);
  }

  releaseAll(): void {
    this.counts.fill(0);
    this.rows.fill(0);
  }

  /** `colOut`: driven column levels (0 = selected). Returns row levels (0 = a selected column has that row pressed). */
  scanColumns(colOut: number): number {
    let result = 0xff;
    for (let col = 0; col < 8; col++) {
      if (((colOut >> col) & 1) === 0) result &= ~this.rows[col]!;
    }
    return result & 0xff;
  }

  /** `rowOut`: driven row levels (0 = selected). Returns column levels (0 = a selected row is pressed in that column). */
  scanRows(rowOut: number): number {
    let result = 0xff;
    for (let col = 0; col < 8; col++) {
      if ((this.rows[col]! & ~rowOut & 0xff) !== 0) result &= ~(1 << col);
    }
    return result & 0xff;
  }
}
