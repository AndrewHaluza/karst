/** Placeholder in `karst.example.yml` for the opened workspace folder. */
export const WORKSPACE_ROOT_TOKEN = '/__WORKSPACE_ROOT__';

/**
 * The scaffold written to a new project's karst.yml: the bundled template with a
 * generated `id` and the live repository's `repoPath` pointed at the workspace
 * folder, so a scaffold applied as-is never references a missing path.
 */
export function stampScaffold(template: string, slug: string, workspaceRoot: string): string {
  return `id: ${slug}\n\n${template.replaceAll(WORKSPACE_ROOT_TOKEN, workspaceRoot)}`;
}
