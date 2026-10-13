import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { manifestText } from './fixtures.js';

export interface Workspace { workspaceDir: string; repoDir: string; remoteDir: string; manifestPath: string }

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'karst', GIT_AUTHOR_EMAIL: 'karst@example.invalid',
  GIT_COMMITTER_NAME: 'karst', GIT_COMMITTER_EMAIL: 'karst@example.invalid',
};
const git = (args: string[], cwd?: string): void => {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });
};

export function buildWorkspace(root: string): Workspace {
  const remoteDir = join(root, 'remote.git');
  const workspaceDir = join(root, 'workspace');
  const repoDir = join(workspaceDir, 'repo');
  const manifestPath = join(workspaceDir, '.karst', 'karst.yml');
  mkdirSync(workspaceDir, { recursive: true });
  git(['init', '--bare', '--initial-branch=main', remoteDir]);
  git(['init', '--initial-branch=main', repoDir]);
  writeFileSync(join(repoDir, 'README.md'), '# fixture repo\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'chore: fixture seed'], repoDir);
  git(['remote', 'add', 'origin', remoteDir], repoDir);
  git(['push', '-u', 'origin', 'main'], repoDir);
  mkdirSync(join(workspaceDir, '.karst'), { recursive: true });
  writeFileSync(manifestPath, manifestText(repoDir));
  return { workspaceDir, repoDir, remoteDir, manifestPath };
}
