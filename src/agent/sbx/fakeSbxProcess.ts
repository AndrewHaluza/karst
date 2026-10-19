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
      // Host git runs with `-c k=v` isolation flags; keys may omit them.
      const bare = line.replace(/^git (?:-c \S+ )+/, 'git ');
      const key = Object.keys(answers)
        .filter((k) => line.startsWith(k) || bare.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      // `sbx exec … karst-bundle <branch>` (sync bundle-out) answers a tiny base64 bundle unless a test says otherwise.
      const bundleOut = command === 'sbx' && args.includes('karst-bundle') ? { stdout: 'YnVuZGxl' } : {};
      const hit = key === undefined ? bundleOut : answers[key]!;
      return Promise.resolve({ code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' });
    },
  };
}
