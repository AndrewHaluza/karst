// The tools a native addon's SOURCE build needs, and the repair sentence when
// one of them is missing.
//
// better-sqlite3 ships a published prebuild for most (runtime, platform, arch)
// triples, so a machine that only wants to RUN the extension never needs a
// compiler. The triples with no published prebuild — linux-arm64 among them —
// fall back to a source build, and that build needs Python (node-gyp runs on
// it), make and a C++ compiler. A slim container image has none of the three,
// and the resulting gyp error reads like a build defect when it is really a
// missing capability.
//
// Pure and dependency-free: the probe is a PATH lookup (no spawn), so a test
// can inject the PATH it wants to see.

import { hasBinary } from './onPath.mjs';

/**
 * The tools a source build needs, each with the binaries that satisfy it. The
 * first alternative that exists on PATH wins.
 */
export const BUILD_TOOLS = [
  { id: 'python', label: 'python3', alternatives: ['python3', 'python'] },
  { id: 'make', label: 'make', alternatives: ['make', 'gmake'] },
  { id: 'compiler', label: 'a C++ compiler', alternatives: ['cc', 'gcc', 'g++', 'clang++'] },
];

/** POSIX's "command not found" exit code — the capability is not installed. */
export const EXIT_COMMAND_NOT_FOUND = 127;

/**
 * The binaries on PATH, as an absolute-path lookup. The PATH is injectable, so
 * a test can ask about a PATH it made up.
 */
function pathLookup(pathEnv, platform) {
  return (binary) => hasBinary(binary, pathEnv, platform);
}

/**
 * The build tools this machine is MISSING, in `BUILD_TOOLS` order. Empty means
 * a source build can run here.
 */
export function missingBuildTools(pathEnv = process.env.PATH, platform = process.platform) {
  const has = pathLookup(pathEnv, platform);
  return BUILD_TOOLS.filter((tool) => !tool.alternatives.some(has)).map((tool) => tool.label);
}

/**
 * The sentence that names what is missing and how to get it. Written for the
 * person reading a gate log: the repair, not just the diagnosis.
 */
export function buildToolsRepair(missing) {
  if (missing.length === 0) return '';
  const list = missing.join(', ');
  return (
    `better-sqlite3 has no published prebuild for this platform/arch, and this machine cannot build it: ` +
    `missing ${list}. Install a C++ toolchain and Python (Debian/Ubuntu: "apt-get install build-essential python3"; ` +
    `macOS: "xcode-select --install"), or run the gate where a published prebuild is available.`
  );
}
