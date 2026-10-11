// Prism grammar for C64Script, shared by the playground and the home-page slideshow.

export const GRAMMAR = {
  string: { pattern: /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])'/, greedy: true },
  comment: { pattern: /\/\/.*/, greedy: true },
  annotation: { pattern: /@(?:zp|inline|addr|0x[0-9a-fA-F]+)/, alias: 'attr-name' },
  keyword:
    /\b(?:program|fn|let|const|loop|while|for|if|else|break|continue|return|data|struct|hardware|asm|clobbers)\b/,
  type: { pattern: /\b(?:u8|u16|bool|void)\b/, alias: 'class-name' },
  hardware: { pattern: /\b(?:VIC2|SID|CIA1|CIA2)\b/, alias: 'property' },
  constant: {
    pattern:
      /\bCOLOR_(?:BLACK|WHITE|RED|CYAN|PURPLE|GREEN|BLUE|YELLOW|ORANGE|BROWN|LIGHT_RED|DARK_GREY|MEDIUM_GREY|LIGHT_GREEN|LIGHT_BLUE|LIGHT_GREY)\b/,
    alias: 'boolean',
  },
  builtin: { pattern: /\b(?:poke|puts|clrscr|lo|hi|screen|color)(?=\s*\()/, alias: 'function' },
  instruction: {
    pattern:
      /\b(?:adc|and|asl|bcc|bcs|beq|bit|bmi|bne|bpl|brk|bvc|bvs|clc|cld|cli|clv|cmp|cpx|cpy|dec|dex|dey|eor|inc|inx|iny|jmp|jsr|lda|ldx|ldy|lsr|nop|ora|pha|php|pla|plp|rol|ror|rti|rts|sbc|sec|sed|sei|sta|stx|sty|tax|tay|tsx|txa|txs|tya)\b(?=[ \t]+[#$(\w{]|[ \t]*$)/im,
    alias: 'function',
  },
  number: /\$[0-9a-fA-F]+\b|\b0x[0-9a-fA-F]+\b|\b\d+\b/,
  operator: /[-+*/=<>!&|^%]+/,
  punctuation: /[{}[\];(),.:]/,
};
