import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('C64Script game-authoring docs', () => {
  const readme = read('README.md');
  const agents = read('AGENTS.md');
  const guide = read('docs/c64script-games.md');
  const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

  it('links the repo entry points to the game guide and live preview', () => {
    expect(readme).not.toMatch(/demo site is planned/i);
    expect(readme).toContain('docs/c64script-games.md');
    expect(agents).toContain('docs/c64script-games.md');
    expect(agents).toContain('127.0.0.1:8080');
    expect(guide).toContain('127.0.0.1:8080');
  });

  it('documents CLI commands that are registered and supported', () => {
    expect(packageJson.scripts.c64script).toBe('node scripts/c64script.mjs');
    const cli = read('scripts/lib/c64script-cli.mjs');
    for (const command of ['new', 'check', 'build', 'run', 'test']) {
      expect(cli).toContain(`'${command}'`);
      expect(guide).toContain(` c64script -- ${command} `);
    }
  });

  it('points agents to current showcase examples', () => {
    for (const example of ['flappy-bird.c64s', 'space-invaders.c64s', 'crystal-climb.c64s']) {
      expect(guide).toContain(example);
    }
  });
});
