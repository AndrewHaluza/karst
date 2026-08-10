import { spawn } from 'node:child_process';

/** Run a small OS probe without blocking the extension host, bounded by `timeoutMs`. */
export function commandOutput(
  command: string,
  args: string[],
  timeoutMs = 2_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      finish(null);
      return;
    }
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code === 0 ? stdout : null));
    timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs).unref();
  });
}
