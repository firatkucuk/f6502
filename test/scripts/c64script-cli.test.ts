import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { main } from '../../scripts/lib/c64script-cli.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = resolve(ROOT, 'scripts/c64script.mjs');
const source = `program @ 0x0810 {
  poke(0x0900, 42);
  puts(1, 1, "RUNNING", COLOR_WHITE);
  loop {}
}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'c64script-cli-'));
  const sourcePath = join(dir, 'game.c64s');
  writeFileSync(sourcePath, source);
  return { dir, sourcePath };
}

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

describe('C64Script CLI', () => {
  it('checks and builds a PRG at the C64Script load address', () => {
    const { dir, sourcePath } = fixture();
    const checked = runCli(['check', sourcePath, '--json'], dir);
    expect(checked.status).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({
      ok: true,
      command: 'check',
      result: { loadAddress: 0x0810 },
    });

    const output = join(dir, 'game.prg');
    const built = runCli(['build', sourcePath, '--out', output, '--json'], dir);
    expect(built.status).toBe(0);
    expect([...readFileSync(output).subarray(0, 2)]).toEqual([0x10, 0x08]);
  });

  it('returns located compile errors as JSON and exits unsuccessfully', () => {
    const { dir, sourcePath } = fixture();
    writeFileSync(sourcePath, 'program @ 0x0810 {\n  let x: u8 = ;\n}');
    const result = runCli(['check', sourcePath, '--json'], dir);

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatchObject({ name: expect.any(String), line: 2, col: expect.any(Number) });
    expect(payload.error.message).toContain('expression');
  });

  it('rejects unknown commands, options, and invalid frame counts', () => {
    const { dir, sourcePath } = fixture();
    expect(runCli(['wat', '--json'], dir).status).toBe(1);
    expect(runCli(['check', sourcePath, '--unknown', '--json'], dir).status).toBe(1);

    const invalidFrames = runCli(['run', sourcePath, '--frames', '0', '--json'], dir);
    expect(invalidFrames.status).toBe(1);
    expect(JSON.parse(invalidFrames.stdout).error.message).toMatch(/positive safe integer/i);
  });

  it('runs a bounded program and returns its screen text', () => {
    const { dir, sourcePath } = fixture();
    const result = runCli(['run', sourcePath, '--frames', '2', '--json'], dir);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).result.screen.join('\n')).toContain('RUNNING');
  });

  it('executes a scenario from a JSON file', () => {
    const { dir, sourcePath } = fixture();
    const scenarioPath = join(dir, 'game.scenario.json');
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        version: 1,
        maxFrames: 5,
        steps: [
          { assertText: { contains: 'RUNNING' } },
          { assertMemory: { address: 0x0900, equals: 42 } },
        ],
      }),
    );
    const result = runCli(['test', sourcePath, '--scenario', scenarioPath, '--json'], dir);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).result).toMatchObject({ passed: true, assertions: 2 });
  });

  it('prints actionable build guidance when the compiled package is missing', async () => {
    const { dir, sourcePath } = fixture();
    const result = await main(['check', sourcePath], { cwd: dir, apiPath: join(dir, 'missing.js') });

    expect(result.exitCode).toBe(1);
    expect(result.result.error.message).toMatch(/npm run build/);
  });

  it('creates a new game from an injected template without overwriting files', async () => {
    const { dir } = fixture();
    const templateDir = join(dir, 'templates');
    mkdirSync(templateDir);
    writeFileSync(join(templateDir, 'sprite-game.c64s'), source);
    writeFileSync(join(templateDir, 'sprite-game.scenario.json'), '{"version":1,"maxFrames":1,"steps":[]}');
    const outputDir = join(dir, 'new-game');

    const created = await main(['new', outputDir, '--template', 'sprite'], { cwd: dir, templateDir });
    expect(created.exitCode).toBe(0);
    expect(readFileSync(join(outputDir, 'game.c64s'), 'utf8')).toBe(source);

    const scenarioPath = join(outputDir, 'game.scenario.json');
    writeFileSync(scenarioPath, 'keep this file');
    const refused = await main(['new', outputDir, '--template', 'sprite'], { cwd: dir, templateDir });
    expect(refused.exitCode).toBe(1);
    expect(existsSync(join(outputDir, 'game.c64s'))).toBe(true);
    expect(readFileSync(scenarioPath, 'utf8')).toBe('keep this file');
  });

  it('ships a compiling sprite game template with a passing behavior scenario', () => {
    const sourcePath = resolve(ROOT, 'templates/c64script/sprite-game.c64s');
    const scenarioPath = resolve(ROOT, 'templates/c64script/sprite-game.scenario.json');
    const checked = runCli(['check', sourcePath, '--json'], ROOT);
    expect(checked.status).toBe(0);
    expect(JSON.parse(checked.stdout).result.loadAddress).toBe(0x0810);

    const tested = runCli(['test', sourcePath, '--scenario', scenarioPath, '--json'], ROOT);
    expect(tested.status).toBe(0);
    expect(JSON.parse(tested.stdout).result.passed).toBe(true);
  });
});
