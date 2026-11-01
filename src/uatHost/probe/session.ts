import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runSteps, type ProbeHost, type StepResult } from './runner.js';
import { parseSteps } from './steps.js';

export interface ProbeRunArgs {
  scriptPath: string;
  outDir: string;
}

const stepFile = (i: number) => `step-${String(i).padStart(3, '0')}.json`;

/** Reads the steps file, runs it, and leaves one JSON evidence file per step plus a summary. */
export async function runProbeScript(args: ProbeRunArgs, host: ProbeHost, totalTimeoutMs?: number, maxStepMs?: number): Promise<StepResult[]> {
  // Async fs: the probe runs on the extension host's single thread (arch:UATHOST-02).
  const steps = parseSteps(JSON.parse(await readFile(args.scriptPath, 'utf8')) as unknown, maxStepMs);
  await mkdir(args.outDir, { recursive: true });
  const write = (name: string, body: unknown) => writeFile(join(args.outDir, name), `${JSON.stringify(body, null, 2)}\n`);
  const results = await runSteps(steps, {
    host,
    writeEvidence: (i, evidence) => write(stepFile(i), evidence),
    ...(totalTimeoutMs ? { totalTimeoutMs } : {}),
  });
  await write('summary.json', { total: steps.length, ran: results.length, results });
  return results;
}
