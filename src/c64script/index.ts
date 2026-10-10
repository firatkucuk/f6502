import { tokenize } from './lexer';
import { parse } from './parser';
import { check } from './checker';
import { generate } from './codegen';
import { link } from './linker';
import { writePrg } from './prg-writer';

export interface CompileOpts {
  /** Override load address (default taken from program block). */
  loadAddr?: number;
}

export function compile(source: string, _opts?: CompileOpts): Uint8Array {
  const tokens = tokenize(source);
  const ast    = parse(tokens);
  const checked = check(ast);
  const buf    = generate(checked);
  const linked = link(buf);
  return writePrg(linked);
}

export { LexError, ParseError, TypeError, CodeGenError } from './errors';
export type { CheckedProgram } from './checker';
export type { Program } from './ast';
