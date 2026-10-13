import type { ProcessResult, ProcessRunOptions, SbxProcess } from './sbxProcess.js';

export interface FakeCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly opts?: ProcessRunOptions;
}

/** Test double: answers by `"<command> <first args>"` prefix; unmatched → code 0, empty output. */
export function fakeSbxProcess(
  answers: Record<string, Partial<ProcessResult>> = {},
): SbxProcess & { readonly calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  return {
    calls,
    run: (command, args, opts) => {
      calls.push({ command, args: [...args], ...(opts ? { opts } : {}) });
      const line = [command, ...args].join(' ');
      const key = Object.keys(answers)
        .filter((k) => line.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const hit = key === undefined ? {} : answers[key]!;
      return Promise.resolve({ code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' });
    },
  };
}
