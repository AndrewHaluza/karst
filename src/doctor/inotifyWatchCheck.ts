import type { DoctorCheck } from './types.js';

export const INOTIFY_CHECK_ID = 'tools.inotify-watches';

export interface InotifyProbes {
  platform: NodeJS.Platform;
  pid: number;
  maxUserWatches: () => number | undefined;
  countInotifyWatches: (pid: number) => number | undefined;
}

export function checkInotifyWatches(probes: InotifyProbes): DoctorCheck[] {
  if (probes.platform !== 'linux') {
    return [];
  }

  const limit = probes.maxUserWatches();
  if (limit === undefined || limit <= 0) {
    return [
      {
        id: INOTIFY_CHECK_ID,
        area: 'tools',
        status: 'warn',
        detail: 'Cannot read /proc/sys/fs/inotify/max_user_watches',
        fix: {
          tier: 'report',
          summary: 'Check fs.inotify.max_user_watches system setting',
          nextStep: 'Ensure /proc/sys/fs/inotify/max_user_watches exists and is readable.',
        },
      },
    ];
  }

  const count = probes.countInotifyWatches(probes.pid);
  if (count === undefined) {
    return [
      {
        id: INOTIFY_CHECK_ID,
        area: 'tools',
        status: 'warn',
        detail: `Cannot read inotify watch count from /proc/${probes.pid}/fdinfo/*`,
        fix: {
          tier: 'report',
          summary: 'Inspect process file descriptor info in /proc',
          nextStep: `Check permissions for /proc/${probes.pid}/fdinfo/.`,
        },
      },
    ];
  }

  const countFormatted = count.toLocaleString('en-US');
  const limitFormatted = limit.toLocaleString('en-US');
  const ratio = count / limit;

  if (ratio >= 0.95) {
    return [
      {
        id: INOTIFY_CHECK_ID,
        area: 'tools',
        status: 'fail',
        detail: `Extension host holds ${countFormatted} inotify watches, exceeding 95% of fs.inotify.max_user_watches (${limitFormatted}). Likely cause: recursive watchers on worktrees with node_modules.`,
        fix: {
          tier: 'report',
          summary: 'Raise fs.inotify.max_user_watches inotify watch limit',
          nextStep:
            'Raise the limit immediately with `sudo sysctl fs.inotify.max_user_watches=524288`, and persist it by adding `fs.inotify.max_user_watches = 524288` to `/etc/sysctl.d/60-karst-inotify.conf` or `/etc/sysctl.conf`.',
        },
      },
    ];
  }

  if (ratio >= 0.8) {
    return [
      {
        id: INOTIFY_CHECK_ID,
        area: 'tools',
        status: 'warn',
        detail: `Extension host holds ${countFormatted} inotify watches, exceeding 80% of fs.inotify.max_user_watches (${limitFormatted}). Likely cause: recursive watchers on worktrees with node_modules.`,
        fix: {
          tier: 'report',
          summary: 'Raise fs.inotify.max_user_watches inotify watch limit',
          nextStep:
            'Raise the limit immediately with `sudo sysctl fs.inotify.max_user_watches=524288`, and persist it by adding `fs.inotify.max_user_watches = 524288` to `/etc/sysctl.d/60-karst-inotify.conf` or `/etc/sysctl.conf`.',
        },
      },
    ];
  }

  return [
    {
      id: INOTIFY_CHECK_ID,
      area: 'tools',
      status: 'ok',
      detail: `Extension host holds ${countFormatted} of ${limitFormatted} inotify watches (fs.inotify.max_user_watches).`,
    },
  ];
}
