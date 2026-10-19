import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Hardened transfer directory for agent-produced files (arch:AC-34): the host
 * never follows a link, never overwrites a foreign file, and builds every path
 * itself. Shared by the sbx sync (F18) and the docker refresh (F8).
 */
export interface Xfer {
  readonly dir: string;
  /** Write `data` as `name` via temp + rename with `O_NOFOLLOW|O_EXCL`; returns the host-built path. */
  write(name: string, data: Uint8Array): Promise<string>;
  /** The path of `name` after confirming it is a regular file (not a link); throws otherwise. */
  verified(name: string): Promise<string>;
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

function safeName(name: string): string {
  if (!NAME.test(name) || name === '.' || name === '..') throw new Error(`xfer: unsafe file name ${JSON.stringify(name)}`);
  return name;
}

async function assertRealDir(dir: string): Promise<void> {
  const st = await lstat(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`xfer: ${dir} is not a real directory`);
}

/** Open an existing directory as an `Xfer`, refusing a link or a non-directory. */
export async function openXfer(dir: string): Promise<Xfer> {
  await assertRealDir(dir);
  return {
    dir,
    write: async (name, data) => {
      await assertRealDir(dir);
      const target = join(dir, safeName(name));
      const temp = join(dir, `.${safeName(name)}.${process.pid}.${Date.now()}.tmp`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      await rename(temp, target);
      return target;
    },
    verified: async (name) => {
      await assertRealDir(dir);
      const target = join(dir, safeName(name));
      const st = await lstat(target);
      if (st.isSymbolicLink() || !st.isFile()) throw new Error(`xfer: ${target} is not a regular file`);
      return target;
    },
  };
}

/** A fresh 0700 host-private transfer dir under the OS temp dir, removed after `body`. */
export async function withXfer<T>(body: (xfer: Xfer) => Promise<T>, root: string = tmpdir()): Promise<T> {
  const dir = await mkdtemp(join(await realpath(root), 'karst-xfer-'));
  try {
    return await body(await openXfer(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
