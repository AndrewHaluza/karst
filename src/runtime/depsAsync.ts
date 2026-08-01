import { spawn } from 'node:child_process';
import { prepareCommand } from './command.js';
import {
  requiredFor,
  type Capability,
  type DependencyFault,
  type RequiredDependency,
} from './deps.js';

const DEFAULT_TIMEOUT_MS = 3_000;

export interface AsyncCommandProbeOptions {
  timeoutMs?: number;
}

export type AsyncCommandProbe = (
  binary: string,
  args: readonly string[],
) => Promise<boolean>;

/**
 * Run a dependency readiness command without blocking the extension host.
 * A hung or failed command is simply unavailable to its point-of-use guard;
 * output is ignored because readiness is defined only by a clean exit code.
 */
export function commandSucceedsAsync(
  binary: string,
  args: readonly string[],
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

async function dependencyStateAsync(
  dependency: RequiredDependency,
  probe: AsyncCommandProbe,
): Promise<DependencyFault | undefined> {
  if (!await probe(dependency.binary, ['--version'])) {
    return { dep: dependency, state: 'missing' };
  }
  if (dependency.ready && !await probe(dependency.binary, dependency.ready.args)) {
    return { dep: dependency, state: 'not-ready' };
  }
  return undefined;
}

/** Async, timeout-capable equivalent of the point-of-use capability guard. */
export async function ensureCapabilityAsync(
  capability: Capability,
  registry: readonly RequiredDependency[],
  probe: AsyncCommandProbe = commandSucceedsAsync,
): Promise<DependencyFault[]> {
  const faults: DependencyFault[] = [];
  for (const dependency of requiredFor(capability, registry)) {
    const fault = await dependencyStateAsync(dependency, probe);
    if (fault) faults.push(fault);
  }
  return faults;
}
