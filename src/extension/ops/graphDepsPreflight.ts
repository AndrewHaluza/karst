import type { Manifest } from '../../manifest/types.js';
import { preflightWarning, preflightWorkspaceDeps } from '../../approaches/graph/workspace/depsPreflight.js';

/** The preflight warning of each graph run: set at the planner launch, read by the Inside header. A reload clears it. */
export function createGraphDepsPreflight(deps: {
  manifest: () => Manifest | undefined;
  domainsOf: (graphRunId: number) => readonly { repoName: string; worktreePath: string }[];
  gitCommonDirOf: (worktree: string) => string | null;
}): { preflight: (graphRunId: number) => Promise<string | undefined>; warningOf: (graphRunId: number) => string | undefined } {
  const warnings = new Map<number, string>();
  return {
    warningOf: (graphRunId) => warnings.get(graphRunId),
    preflight: async (graphRunId) => {
      const assessments = await preflightWorkspaceDeps({
        manifest: deps.manifest(),
        repos: deps.domainsOf(graphRunId).map((d) => ({
          repoName: d.repoName,
          worktree: d.worktreePath,
          gitCommonDir: deps.gitCommonDirOf(d.worktreePath),
        })),
      });
      const warning = preflightWarning(assessments);
      if (warning === undefined) warnings.delete(graphRunId);
      else warnings.set(graphRunId, warning);
      return warning;
    },
  };
}
