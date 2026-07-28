import { describe, expect, it, vi } from 'vitest';
import { OUTPUT_TRUNCATION_MARKER } from '../runtime/boundedOutput.js';
import { cancelAllNpmCommands, runNpmCommand } from './npmCommand.js';

describe('runNpmCommand', () => {
  it('yields the event loop while the command is pending', async () => {
    let turnRan = false;
    const result = runNpmCommand(
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 80)"`,
      process.cwd(),
      { timeoutMs: 1_000 },
    );
    setImmediate(() => {
      turnRan = true;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(turnRan).toBe(true);
    expect((await result).code).toBe(0);
  });

  it('bounds combined noisy output and marks truncation', async () => {
    const script =
      'process.stdout.write("o".repeat(4096));process.stderr.write("e".repeat(4096));process.exit(2)';
    const result = await runNpmCommand(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      process.cwd(),
      { timeoutMs: 1_000, maxOutputBytes: 128 },
    );

    expect(result.code).toBe(2);
    expect(Buffer.byteLength(result.out)).toBeLessThan(200);
    expect(result.out.split(OUTPUT_TRUNCATION_MARKER)).toHaveLength(2);
  });

  it('times out and terminates a command with a live descendant', async () => {
    const script =
      'const{spawn}=require("node:child_process");spawn(process.execPath,["-e","setInterval(()=>{},1000)"]);setInterval(()=>{},1000)';
    const started = Date.now();
    const result = await runNpmCommand(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      process.cwd(),
      { timeoutMs: 40, terminationGraceMs: 500 },
    );

    expect(result.code).toBe(1);
    expect(result.out).toContain('timed out after 40ms');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('clears its deadline after normal close', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const result = await runNpmCommand(
      `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      process.cwd(),
      { timeoutMs: 1_000 },
    );

    expect(result.code).toBe(0);
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('cancels active detached process trees during host teardown', async () => {
    const result = runNpmCommand(
      `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
      process.cwd(),
      { timeoutMs: 10_000, terminationGraceMs: 500 },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    await cancelAllNpmCommands();
    expect((await result).code).toBe(1);
  });
});
