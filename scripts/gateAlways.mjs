// Tests that `vitest related` cannot reach from a changed file (@arch:GATE-REPEAT): they read built
// *.webview.js bundles, scan the source tree, or enforce a ratchet. A narrowed first pass adds them,
// per vitest config, when the branch diff holds a src/ui path.

/** Test files by config. A file must match the config's include and exclude. */
export const ALWAYS_RUN = {
  unit: [
    'src/model/dashboardAppInjector.test.ts',
    'src/model/resourcesAppInjector.test.ts',
    'src/model/settingsAppInjector.test.ts',
    'src/model/sidebarAppInjector.test.ts',
    'src/model/agentPicker.test.ts',
    'src/model/agentPicker.dom.test.ts',
    'src/model/agentPicker.staged.dom.test.ts',
    'src/ui/settings/webview.shell.test.ts',
    'src/ui/dashboard/serverLogsSurface.test.ts',
    'src/ui/webviewSendContract.test.ts',
    'src/ui/dashboard/app/architecture.test.ts',
    'src/ui/resources/app/architecture.test.ts',
    'src/ui/settings/app/architecture.test.ts',
    'src/ui/sidebar/app/architecture.test.ts',
    'src/extension/ops/placementRule.test.ts',
    'src/extension/ops/ratchet.test.ts',
    'src/extension/toastSeam.ratchet.test.ts',
    'src/extension/stallCommandsRemoved.test.ts',
    'src/workflow/graphBoundary.test.ts',
    'src/agent/bridge/fsCalls.conformance.test.ts',
    'src/context/hostGitFree.test.ts',
  ],
  integration: ['src/ui/measure-floors.integration.test.ts', 'src/ui/runtimeConformance.render.integration.test.ts'],
};

const INTEGRATION_CONFIG = 'vitest.integration.config.ts';

/** The ALWAYS files for this gate's vitest args when the changed paths hold a src/ui path; else none. */
export function alwaysFiles(args, paths) {
  if (!paths.some((p) => p.startsWith('src/ui/'))) return [];
  return args.includes(INTEGRATION_CONFIG) ? ALWAYS_RUN.integration : ALWAYS_RUN.unit;
}
