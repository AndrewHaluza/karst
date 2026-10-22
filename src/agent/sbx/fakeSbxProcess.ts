import type { ProcessResult, ProcessRunOptions, SbxProcess } from './sbxProcess.js';

export interface FakeCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly opts?: ProcessRunOptions;
}

/** Test double: answers by `"<command> <first args>"` prefix; unmatched → code 0, empty output. */
export function fakeSbxProcess(
  answers: Record<string, Partial<ProcessResult>> = {},
  /** `keepListing`: a removed name keeps showing in `ls`/`ps` (a daemon that swallowed the rm). */
  opts: { readonly keepListing?: boolean } = {},
): SbxProcess & { readonly calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  // A successful (or already-gone) `rm` drops the name from later listings, like the real inventory.
  const gone = new Set<string>();
  return {
    calls,
    run: (command, args, runOpts) => {
      calls.push({ command, args: [...args], ...(runOpts ? { opts: runOpts } : {}) });
      const line = [command, ...args].join(' ');
      // Host git runs with `-c k=v` isolation flags; keys may omit them.
      const bare = line.replace(/^git (?:-c \S+ )+/, 'git ');
      const key = Object.keys(answers)
        .filter((k) => line.startsWith(k) || bare.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      // `sbx exec … karst-bundle <branch>` (sync bundle-out) answers a tiny base64 bundle unless a test says otherwise.
      const bundleOut = command === 'sbx' && args.includes('karst-bundle') ? ({ stdout: 'YnVuZGxl' } as Partial<ProcessResult>) : ({} as Partial<ProcessResult>);
      const hit = key === undefined ? bundleOut : answers[key]!;
      const res = { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
      if (opts.keepListing) return Promise.resolve(res);
      if (args[0] === 'rm' && (res.code === 0 || /no such/i.test(res.stderr))) for (const n of args.slice(1)) if (!n.startsWith('-')) gone.add(n);
      const listed = (command === 'sbx' && args[0] === 'ls') || (command === 'docker' && args[0] === 'ps');
      if (listed && gone.size > 0) res.stdout = res.stdout.split('\n').filter((l) => ![...gone].some((n) => l.includes(n))).join('\n');
      return Promise.resolve(res);
    },
  };
}
