/**
 * Cloud agent-session links (arch:CLOUD-01). Provider registry and URL guards for
 * sessions an agent ran in a vendor's cloud (claude.ai Code on the web first).
 * Display-only: nothing here may influence stage, gates or agent_state.
 *
 * Adding a provider is ONE entry in `CLOUD_SESSION_PROVIDERS` plus a test.
 */

export interface CloudSessionProvider {
  provider: string;
  label: string;
  /** Matches the whole session URL; must be an https URL on `host`. */
  pattern: string;
  host: string;
}

export const CLOUD_SESSION_PROVIDERS: readonly CloudSessionProvider[] = [
  {
    provider: 'claude',
    label: 'Claude Code on the web',
    pattern: 'https://claude\\.ai/code/session_[A-Za-z0-9_-]+',
    host: 'claude.ai',
  },
];

/** True for an https URL whose host is a registered provider host (guard before opening a browser). */
export function isOpenableCloudUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && CLOUD_SESSION_PROVIDERS.some((p) => p.host === u.hostname);
}

/** The provider whose pattern matches `url` exactly, or undefined. */
export function providerForUrl(url: string): CloudSessionProvider | undefined {
  return CLOUD_SESSION_PROVIDERS.find((p) => new RegExp(`^${p.pattern}$`).test(url));
}
