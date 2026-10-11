import { basename } from 'node:path';

/** Tree prefix for a repo: `worktrees.repo` and capture targets hold the repo PATH; the store keys files by its basename. */
export const treeRepoName = (repoPath: string): string => basename(repoPath);
