import type { DoctorCheck } from './types.js';

export const INOTIFY_CHECK_ID = 'tools.inotify-watches';
const WARN_RATIO = 0.8;
const FAIL_RATIO = 0.95;
const RECOMMENDED_LIMIT = 524288;

export interface InotifyProbes {
  platform: NodeJS.Platform;
  maxUserWatches: () => number | undefined;
  /** Total inotify watches held by every process of the current user (the limit is per-user). */
  countInotifyWatches: () => number | undefined;
}

function warn(detail: string, summary: string, nextStep: string): DoctorCheck[] {
  return [{ id: INOTIFY_CHECK_ID, area: 'tools', status: 'warn', detail, fix: { tier: 'report', summary, nextStep } }];
}

export function checkInotifyWatches(probes: InotifyProbes): DoctorCheck[] {
  if (probes.platform !== 'linux') return [];

  const limit = probes.maxUserWatches();
  if (limit === undefined || limit <= 0) {
    return warn(
      'Cannot read /proc/sys/fs/inotify/max_user_watches',
      'Check fs.inotify.max_user_watches system setting',
      'Ensure /proc/sys/fs/inotify/max_user_watches exists and is readable.',
    );
  }

  const count = probes.countInotifyWatches();
  if (count === undefined) {
    return warn(
      'Cannot read inotify watch count from /proc/<pid>/fdinfo/*',
      'Inspect process file descriptor info in /proc',
      'Check permissions for /proc/<pid>/fdinfo/ of your own processes.',
    );
  }

  const usage = `${count.toLocaleString('en-US')} inotify watches`;
  const limitText = limit.toLocaleString('en-US');
  const ratio = count / limit;
  if (ratio < WARN_RATIO) {
    return [{ id: INOTIFY_CHECK_ID, area: 'tools', status: 'ok', detail: `Your processes hold ${usage} of ${limitText} (fs.inotify.max_user_watches).` }];
  }

  const pct = ratio >= FAIL_RATIO ? 95 : 80;
  const fix = {
    tier: 'report' as const,
    summary: 'Raise fs.inotify.max_user_watches inotify watch limit',
    nextStep: `Raise the limit immediately with \`sudo sysctl fs.inotify.max_user_watches=${RECOMMENDED_LIMIT}\`, and persist it by adding \`fs.inotify.max_user_watches = ${RECOMMENDED_LIMIT}\` to \`/etc/sysctl.d/60-karst-inotify.conf\` or \`/etc/sysctl.conf\`.`,
  };
  return [{
    id: INOTIFY_CHECK_ID,
    area: 'tools',
    status: ratio >= FAIL_RATIO ? 'fail' : 'warn',
    detail: `Your processes hold ${usage}, exceeding ${pct}% of fs.inotify.max_user_watches (${limitText}). Likely cause: recursive watchers on worktrees with node_modules.`,
    fix,
  }];
}
