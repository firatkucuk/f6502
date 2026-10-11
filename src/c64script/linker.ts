import { CodeGenError } from './errors';
import type { CodeBuffer } from './codegen';

/** `__asm3_loop` → `loop`: asm labels are made unique per emission. */
const display = (label: string): string => label.replace(/^__asm\d+_/, '');

export function link(buf: CodeBuffer): { code: Uint8Array; loadAddr: number } {
  const bytes = [...buf.bytes];

  for (const { offset, kind, line } of buf.fixups) {
    switch (kind.tag) {
      case 'abs16': {
        const labelOffset = buf.labels.get(kind.label);
        if (labelOffset === undefined)
          throw new CodeGenError(`unresolved label '${display(kind.label)}'`, line ?? 0, 0);
        const addr = buf.loadAddr + labelOffset;
        bytes[offset] = addr & 0xff;
        bytes[offset + 1] = (addr >> 8) & 0xff;
        break;
      }
      case 'branch8': {
        const labelOffset = buf.labels.get(kind.label);
        if (labelOffset === undefined)
          throw new CodeGenError(`unresolved label '${display(kind.label)}'`, line ?? 0, 0);
        // Relative offset is from the byte AFTER the branch operand
        const rel = labelOffset - (offset + 1);
        if (rel < -128 || rel > 127) {
          throw new CodeGenError(
            `branch out of range to '${display(kind.label)}' (${rel} bytes; a branch reaches -128..+127)`,
            line ?? 0,
            0,
          );
        }
        bytes[offset] = rel & 0xff;
        break;
      }
      case 'absLoByte': {
        const labelOffset = buf.labels.get(kind.label);
        if (labelOffset !== undefined) bytes[offset] = (buf.loadAddr + labelOffset) & 0xff;
        break;
      }
      case 'absHiByte': {
        const labelOffset = buf.labels.get(kind.label);
        if (labelOffset !== undefined) bytes[offset] = ((buf.loadAddr + labelOffset) >> 8) & 0xff;
        break;
      }
      case 'zpByte':
        // ZP addresses are embedded directly at emit time
        break;
    }
  }

  return { code: new Uint8Array(bytes), loadAddr: buf.loadAddr };
}
