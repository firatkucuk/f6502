export class C64ScriptError extends Error {
  constructor(
    message: string,
    public readonly line: number = 0,
    public readonly col: number = 0,
  ) {
    super(line > 0 ? `[${line}:${col}] ${message}` : message);
    this.name = 'C64ScriptError';
  }
}

export class LexError extends C64ScriptError {
  constructor(msg: string, line: number, col: number) {
    super(msg, line, col);
    this.name = 'LexError';
  }
}
export class ParseError extends C64ScriptError {
  constructor(msg: string, line: number, col: number) {
    super(msg, line, col);
    this.name = 'ParseError';
  }
}
export class C64ScriptTypeError extends C64ScriptError {
  constructor(msg: string, line: number, col: number) {
    super(msg, line, col);
    this.name = 'C64ScriptTypeError';
  }
}
export class CodeGenError extends C64ScriptError {
  constructor(msg: string, line: number, col: number) {
    super(msg, line, col);
    this.name = 'CodeGenError';
  }
}
