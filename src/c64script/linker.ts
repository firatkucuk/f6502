import { CodeGenError } from './errors';
import type { CodeBuffer } from './codegen';

export function link(buf: CodeBuffer): { code: Uint8Array; loadAddr: number } {
  const bytes = [...buf.bytes];

  for (const { offset, kind } of buf.fixups) {
    switch (kind.kind) {
      case 'abs16': {
        const labelOffset = buf.labels.get(kind.label);
        if (labelOffset === undefined) throw new CodeGenError(`unresolved label '${kind.label}'`, 0, 0);
        const addr = buf.loadAddr + labelOffset;
        bytes[offset]     = addr & 0xFF;
        bytes[offset + 1] = (addr >> 8) & 0xFF;
        break;
      }
      case 'branch8': {
        const labelOffset = buf.labels.get(kind.label);
        if (labelOffset === undefined) throw new CodeGenError(`unresolved label '${kind.label}'`, 0, 0);
        // Relative offset is from the byte AFTER the branch operand
        const rel = labelOffset - (offset + 1);
        if (rel < -128 || rel > 127) {
          throw new CodeGenError(`branch out of range to '${kind.label}' (${rel} bytes)`, 0, 0);
        }
        bytes[offset] = rel & 0xFF;
        break;
      }
      case 'absLoByte': {
        const labelOffset = buf.labels.get(kind.label);
        if (labelOffset !== undefined) bytes[offset] = (buf.loadAddr + labelOffset) & 0xFF;
        break;
      }
      case 'absHiByte': {
        const labelOffset = buf.labels.get(kind.label);
        if (labelOffset !== undefined) bytes[offset] = ((buf.loadAddr + labelOffset) >> 8) & 0xFF;
        break;
      }
      case 'zpByte':
        // ZP addresses are embedded directly at emit time
        break;
    }
  }

  return { code: new Uint8Array(bytes), loadAddr: buf.loadAddr };
}
