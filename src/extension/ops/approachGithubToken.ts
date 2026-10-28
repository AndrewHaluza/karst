import { ghAuthToken, resolveGithubToken } from '../../approaches/githubAuth.js';

/** Token for an approach install: silent VS Code session, then gh, then env. */
export function resolveInstallToken(
  vscodeSessionToken: () => Promise<string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  return resolveGithubToken({ vscodeSession: vscodeSessionToken, ghCli: ghAuthToken, env });
}
