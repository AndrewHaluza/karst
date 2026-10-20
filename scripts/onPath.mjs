// Is a binary on PATH? One place, so the two gate scripts that answer this
// question agree with each other — and with the platform.
//
// The suffix list matters: on Windows the binaries are `docker.exe`,
// `make.exe` and friends, so a lookup that only tried the bare name would
// report every tool as missing and refuse a build the machine can do.

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** The names a binary may carry on this platform, most specific first. */
export function binaryNames(binary, platform = process.platform) {
  return platform === 'win32' ? [`${binary}.exe`, `${binary}.cmd`, `${binary}.bat`, binary] : [binary];
}

/**
 * Does PATH hold this binary? `pathEnv` and `platform` are injectable so a
 * test can ask about a PATH it made up.
 */
export function hasBinary(binary, pathEnv = process.env.PATH, platform = process.platform) {
  const dirs = (pathEnv ?? '').split(delimiter).filter((dir) => dir.length > 0);
  return dirs.some((dir) => binaryNames(binary, platform).some((name) => existsSync(join(dir, name))));
}
