import { isAbsolute, resolve } from 'node:path';

/**
 * Anchor a RELATIVE gate command to the directory the gate runs in.
 *
 * `child_process.spawn` resolves the program against PATH or against the
 * PARENT process's cwd — never against the `cwd` option it is handed. For a
 * gate that means `command: .venv/bin/pytest` is looked up beside the
 * extension host, not beside the worktree, and is an ENOENT on every machine.
 * A project-local toolchain is the ordinary case outside Node (Python's
 * `.venv/bin/`, Gradle's `./gradlew`, a repo's `./scripts/`), so a relative
 * command that cannot mean "somewhere on PATH" is resolved here instead.
 *
 * A BARE name is left untouched: `pytest`, `npm` and `go` are exactly the
 * commands whose answer PATH is supposed to give, and anchoring them to the
 * worktree would break every gate that names an installed tool. Only a command
 * carrying a path separator is relative-by-intent, which is the same
 * distinction `resolveOnPath` (`runtime/command.ts`) draws on Windows.
 *
 * Host-flavoured paths deliberately (unlike `command.ts`'s win32 helpers):
 * this is about the real filesystem the child will be spawned into.
 */
export function resolveCommandCwd(command: string, cwd: string): string {
  if (command.length === 0) return command;
  if (isAbsolute(command)) return command;
  // No separator: a bare name, which belongs to PATH.
  if (!/[\\/]/.test(command)) return command;
  return resolve(cwd, command);
}
