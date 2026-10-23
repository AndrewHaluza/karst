/**
 * Hosts the sandbox may reach while `sandbox.setup` runs when a repository declares none (arch:AC-36, arch:AC-40).
 * - `registry.npmjs.org`: npm package registry metadata and tarball downloads.
 * - `github.com`: git repository dependencies and GitHub release landing pages.
 * - `objects.githubusercontent.com`: legacy and redirected GitHub release asset storage.
 * - `release-assets.githubusercontent.com`: modern GitHub release assets (prebuild-install/prebuildify native binaries).
 * - `nodejs.org`: Node.js header tarballs for node-gyp native compilation fallback.
 */
export const DEFAULT_SETUP_HOSTS: readonly string[] = [
  'registry.npmjs.org',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'nodejs.org',
];

/** Port every setup host is opened on: package registries and release downloads are HTTPS only. */
export const SETUP_HOST_PORT = 443;

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Why `host` is not a usable setup host, or undefined. The host alias is the baseline's, never a window. */
export function setupHostError(host: string): string | undefined {
  if (host.length > 253 || !HOST.test(host)) return `"${host}" is not a host name or *.suffix`;
  if (host === 'host.docker.internal') return 'must not be the host alias (baseline ports only)';
  return undefined;
}

export const setupHostsOf = (declared: readonly string[] | undefined): readonly string[] =>
  declared && declared.length > 0 ? declared : DEFAULT_SETUP_HOSTS;
