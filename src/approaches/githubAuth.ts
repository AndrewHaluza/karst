import { execFile } from 'node:child_process';

/** One token source: resolves a token, or undefined when it has none. Never throws. */
export type TokenSource = () => Promise<string | undefined>;

export interface GithubAuthDeps {
  /** VS Code GitHub session, silent (must never prompt). */
  vscodeSession: TokenSource;
  /** `gh auth token` output. */
  ghCli: TokenSource;
  env: NodeJS.ProcessEnv;
}

const GH_TIMEOUT_MS = 5000;

/** `gh auth token` stdout, trimmed. The token is a secret: never logged. */
export const ghAuthToken: TokenSource = () =>
  new Promise((resolve) => {
    try {
      execFile('gh', ['auth', 'token'], { timeout: GH_TIMEOUT_MS }, (err, stdout) => {
        const t = err ? '' : String(stdout).trim();
        resolve(t.length > 0 ? t : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });

async function safe(source: TokenSource): Promise<string | undefined> {
  try {
    const t = (await source())?.trim();
    return t !== undefined && t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * First hit wins: VS Code session → `gh auth token` → GH_TOKEN → GITHUB_TOKEN.
 * No token → undefined (unauthenticated fetch, as before).
 */
export async function resolveGithubToken(deps: GithubAuthDeps): Promise<string | undefined> {
  return (
    (await safe(deps.vscodeSession)) ??
    (await safe(deps.ghCli)) ??
    (await safe(async () => deps.env.GH_TOKEN)) ??
    (await safe(async () => deps.env.GITHUB_TOKEN))
  );
}
