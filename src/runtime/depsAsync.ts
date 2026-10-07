import { spawn } from 'node:child_process';
import { prepareCommand } from './command.js';
import {
  requiredFor,
  type Capability,
  type DependencyFault,
  type ProbeEnv,
  type RequiredDependency,
} from './deps.js';

const DEFAULT_TIMEOUT_MS = 3_000;

export interface AsyncCommandProbeOptions {
  timeoutMs?: number;
}

export type AsyncCommandProbe = (
  binary: string,
  args: readonly string[],
  env?: ProbeEnv,
) => Promise<boolean>;

/** Captures `<binary> <args>` stdout + exit code without blocking the host. */
export type AsyncOutputProbe = (
  binary: string,
  args: readonly string[],
  env?: ProbeEnv,
) => Promise<{ stdout: string; exitCode: number }>;

/** The spawn `env` for a probe: host env with the dependency's dirs layered on. */
function probeEnvOption(env?: ProbeEnv): { env: NodeJS.ProcessEnv } | Record<string, never> {
  return env ? { env: { ...process.env, ...env } } : {};
}

/**
 * Run a dependency readiness command without blocking the extension host.
 * A hung or failed command is simply unavailable to its point-of-use guard;
 * output is ignored because readiness is defined only by a clean exit code.
 */
export function commandSucceedsAsync(
  binary: string,
  args: readonly string[],
  env?: ProbeEnv,
  options: AsyncCommandProbeOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const settle = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ready);
    };

    try {
      const prepared = prepareCommand(binary, args);
      child = spawn(prepared.command, prepared.args, {
        stdio: 'ignore',
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
        ...probeEnvOption(env),
      });
      child.once('error', () => settle(false));
      child.once('close', (code) => settle(code === 0));
      timer = setTimeout(() => {
        child?.kill('SIGKILL');
        settle(false);
      }, timeoutMs);
    } catch {
      settle(false);
    }
  });
}

/**
 * Capture a readiness command's stdout without blocking the host, for an
 * output-validating dependency (opencode2's version range). Bounded by the
 * same timeout; a hung command resolves as exit 1 with empty output.
 */
export function commandOutputAsync(
  binary: string,
  args: readonly string[],
  env?: ProbeEnv,
  options: AsyncCommandProbeOptions = {},
): Promise<{ stdout: string; exitCode: number }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let stdout = '';
    const settle = (result: { stdout: string; exitCode: number }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    try {
      const prepared = prepareCommand(binary, args);
      child = spawn(prepared.command, prepared.args, {
        windowsVerbatimArguments: prepared.windowsVerbatimArguments,
        ...probeEnvOption(env),
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.once('error', () => settle({ stdout: '', exitCode: 1 }));
      child.once('close', (code) => settle({ stdout, exitCode: code ?? 1 }));
      timer = setTimeout(() => {
        child?.kill('SIGKILL');
        settle({ stdout: '', exitCode: 1 });
      }, timeoutMs);
    } catch {
      settle({ stdout: '', exitCode: 1 });
    }
  });
}

async function dependencyStateAsync(
  dependency: RequiredDependency,
  probe: AsyncCommandProbe,
  readOutput?: AsyncOutputProbe,
): Promise<DependencyFault | undefined> {
  // An unconfigured dependency is missing before any probe (see deps.ts).
  if (dependency.unavailable) return { dep: dependency, state: 'missing' };
  if (!await probe(dependency.binary, ['--version'], dependency.probeEnv)) {
    return { dep: dependency, state: 'missing' };
  }
  if (dependency.readyOutput) {
    if (!dependency.ready || !readOutput) return { dep: dependency, state: 'not-ready' };
    const { stdout, exitCode } = await readOutput(
      dependency.binary,
      dependency.ready.args,
      dependency.probeEnv,
    );
    return exitCode === 0 && dependency.readyOutput(stdout)
      ? undefined
      : { dep: dependency, state: 'not-ready' };
  }
  if (dependency.ready && !await probe(dependency.binary, dependency.ready.args, dependency.probeEnv)) {
    return { dep: dependency, state: 'not-ready' };
  }
  return undefined;
}

/** Async, timeout-capable equivalent of the point-of-use capability guard. */
export async function ensureCapabilityAsync(
  capability: Capability,
  registry: readonly RequiredDependency[],
  probe: AsyncCommandProbe = commandSucceedsAsync,
  readOutput?: AsyncOutputProbe,
): Promise<DependencyFault[]> {
  const faults: DependencyFault[] = [];
  for (const dependency of requiredFor(capability, registry)) {
    const fault = await dependencyStateAsync(dependency, probe, readOutput);
    if (fault) faults.push(fault);
  }
  return faults;
}
