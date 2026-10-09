import {
  dependencyState,
  renderDependencyFault,
  renderMissingDependency,
  type DependencyProbe,
  type OutputProbe,
  type ReadinessProbe,
  type RequiredDependency,
} from '../runtime/deps.js';
import type { DoctorCheck } from './types.js';

/**
 * `karst doctor` tools area. PURE: every probe is injected, so this file never
 * spawns a process or reads the filesystem. The real host passes the deps.ts
 * probes plus a `--version` parser.
 */

export interface ToolsProbes {
  /** From `dependencyRegistry(provider)`. */
  registry: readonly RequiredDependency[];
  probe: DependencyProbe;
  ready: ReadinessProbe;
  readOutput?: OutputProbe;
  /** Returns the first x.y(.z) parsed from `<binary> --version`, if any. */
  version: (binary: string) => string | undefined;
}

/** Oldest version karst is known to work with. Below it: warn, not fail. */
export const MIN_VERSIONS: Record<string, string> = { git: '2.15.0', gh: '2.0.0' };

type Semver = readonly [number, number, number];

const VERSION_PATTERN = /(\d+)\.(\d+)(?:\.(\d+))?/;

function parseSemver(text: string): Semver | null {
  const match = VERSION_PATTERN.exec(text);
  if (!match) return null;
  const [, major = '0', minor = '0', patch = '0'] = match;
  return [Number(major), Number(minor), Number(patch)];
}

/** True when `a` sorts strictly before `b`, comparing numerically per part. */
function isBelow(a: Semver, b: Semver): boolean {
  const diff = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return diff < 0;
}

function formatSemver(v: Semver): string {
  return v.join('.');
}

function checkInstalled(dep: RequiredDependency, probes: ToolsProbes): DoctorCheck {
  const id = `tools.${dep.binary}`;
  const found = parseSemver(probes.version(dep.binary) ?? '');
  const min = MIN_VERSIONS[dep.binary];
  const minParsed = min === undefined ? null : parseSemver(min);

  if (found && minParsed && isBelow(found, minParsed)) {
    return {
      id,
      area: 'tools',
      status: 'warn',
      detail: `${dep.label} ${formatSemver(found)} is older than ${min}, the oldest karst is tested with.`,
      fix: {
        tier: 'consented',
        summary: `Upgrade ${dep.label}`,
        command: `Upgrade ${dep.label} to ${min} or newer, then reload the window.`,
      },
    };
  }

  return {
    id,
    area: 'tools',
    status: 'ok',
    detail: found ? `${dep.binary} ${formatSemver(found)}` : `${dep.binary} is installed`,
  };
}

function checkDependency(dep: RequiredDependency, probes: ToolsProbes): DoctorCheck {
  const id = `tools.${dep.binary}`;
  const state = dependencyState(dep, probes.probe, probes.ready, probes.readOutput);

  if (state === 'missing') {
    return {
      id,
      area: 'tools',
      status: 'fail',
      detail: renderMissingDependency(dep),
      fix: { tier: 'consented', summary: `Install ${dep.label}`, command: dep.install },
    };
  }
  if (state === 'not-ready') {
    return {
      id,
      area: 'tools',
      status: 'fail',
      detail: renderDependencyFault(dep, state) ?? dep.install,
      fix: {
        tier: 'report',
        summary: `Make ${dep.label} usable`,
        nextStep: dep.ready?.fix ?? dep.install,
      },
    };
  }
  return checkInstalled(dep, probes);
}

/** One `tools.<binary>` check per registry entry, in registry order. */
export function checkTools(probes: ToolsProbes): DoctorCheck[] {
  return probes.registry.map((dep) => checkDependency(dep, probes));
}
