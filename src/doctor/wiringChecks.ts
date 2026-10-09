import type { DoctorCheck } from './types.js';

export interface LauncherProbe {
  path: string;
  exists: boolean;
  pointsAtInstalledExtension: boolean;
  schemaVersion: number | undefined;
  extensionSchemaVersion: number;
}

export interface McpProbe {
  required: boolean;
  configPresent: boolean;
  provider: string;
}

/**
 * Injected probes. Optional probes are omitted entirely when the feature they
 * check does not apply; an omitted probe emits no check at all.
 */
export interface WiringProbes {
  karstCli: string | undefined;
  isRunnableJsFile: (path: string) => boolean;
  launcher?: LauncherProbe;
  mcp?: McpProbe;
  hookChannelReachable?: () => boolean;
}

function cliCheck(p: WiringProbes): DoctorCheck {
  const runnable = p.karstCli !== undefined && p.isRunnableJsFile(p.karstCli);
  if (runnable) {
    return { id: 'wiring.cli', area: 'wiring', status: 'ok', detail: `KARST_CLI runs: ${p.karstCli}` };
  }
  const detail =
    p.karstCli === undefined
      ? 'KARST_CLI is not set'
      : `KARST_CLI is not a runnable JS file: ${p.karstCli}`;
  return {
    id: 'wiring.cli',
    area: 'wiring',
    status: 'fail',
    detail,
    fix: {
      tier: 'report',
      summary: 'The karst CLI is not reachable from the extension',
      nextStep: 'Reinstall or reload the Karst extension, then re-run karst doctor',
    },
  };
}

function launcherCheck(l: LauncherProbe): DoctorCheck {
  if (!l.exists) {
    return {
      id: 'wiring.launcher',
      area: 'wiring',
      status: 'warn',
      detail: `launcher is missing: ${l.path}`,
      fix: {
        tier: 'auto',
        summary: `Recreate the launcher at ${l.path}`,
        action: { kind: 'recreate-launcher' },
      },
    };
  }
  const schemaMatches = l.schemaVersion === l.extensionSchemaVersion;
  if (!l.pointsAtInstalledExtension || !schemaMatches) {
    const reason = l.pointsAtInstalledExtension
      ? `launcher schema ${String(l.schemaVersion)} does not match extension schema ${l.extensionSchemaVersion}`
      : 'launcher points at a different extension install';
    return {
      id: 'wiring.launcher',
      area: 'wiring',
      status: 'fail',
      detail: `${reason}: ${l.path}`,
      fix: {
        tier: 'report',
        summary: 'The launcher is out of date',
        nextStep: 'Update the Karst extension to the latest version, then re-run karst doctor',
      },
    };
  }
  return { id: 'wiring.launcher', area: 'wiring', status: 'ok', detail: `launcher is current: ${l.path}` };
}

function mcpCheck(m: McpProbe): DoctorCheck {
  if (!m.required || m.configPresent) {
    return { id: 'wiring.mcp', area: 'wiring', status: 'ok', detail: `MCP config ok for ${m.provider}` };
  }
  const command = `karst mcp install --agent ${m.provider}`;
  return {
    id: 'wiring.mcp',
    area: 'wiring',
    status: 'warn',
    detail: `MCP is required for ${m.provider} but its config is missing`,
    fix: {
      tier: 'consented',
      summary: `Install the karst MCP config for ${m.provider}`,
      command,
    },
  };
}

function hookCheck(reachable: boolean): DoctorCheck {
  if (reachable) {
    return { id: 'wiring.hook', area: 'wiring', status: 'ok', detail: 'hook channel is reachable' };
  }
  return {
    id: 'wiring.hook',
    area: 'wiring',
    status: 'fail',
    detail: 'hook channel is unreachable',
    fix: {
      tier: 'report',
      summary: 'Agent hooks cannot reach karst',
      nextStep: 'Reload the VS Code window so the hook channel restarts, then re-run karst doctor',
    },
  };
}

export function checkWiring(p: WiringProbes): DoctorCheck[] {
  const checks: DoctorCheck[] = [cliCheck(p)];
  if (p.launcher !== undefined) checks.push(launcherCheck(p.launcher));
  if (p.mcp !== undefined) checks.push(mcpCheck(p.mcp));
  if (p.hookChannelReachable !== undefined) checks.push(hookCheck(p.hookChannelReachable()));
  return checks;
}
