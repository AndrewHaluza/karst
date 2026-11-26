/** The server-logs variants (ui:VISUAL-VARIANTS). */
import { logMatchText } from '../../../src/model/notifyText.js';
import { getCorpus } from '../corpora.js';
import {
  ALL_THEMES,
  LOADING,
  variant,
  stateMessage,
  type Variant,
  type ViewCorpus,
} from '../variantCore.js';

// ----------------------------------------------------------------- others

export const serverLogsVariants = (): Variant[] => {
  const entry = (service: string, content: string, extra: { truncated?: boolean; state?: 'ok' | 'empty' | 'no-path' | 'unreadable'; message?: string } = {}) => ({
    service, logPath: `/tmp/${service}.log`, truncated: false, content, ...extra,
  });
  const logs = (...servers: ReturnType<typeof entry>[]): ViewCorpus => ({ messages: [{ type: 'server-logs', servers }] });
  const line = (n: number) => `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z GET /health ${'x'.repeat(n % 7)} 200 3ms\n`;
  return [
    variant('serverLogs', 'populated', () => getCorpus('serverLogs'), { baseline: 'serverLogs', themes: ALL_THEMES }),
    // T1298: one search hit. The fixture host answers the count with `logMatchText(1)` (the page has no host behind postMessage).
    variant('serverLogs', 'search-one-match', () => getCorpus('serverLogs'), {
      skipLayout: true,
      fill: { selector: '#logsSearch', text: 'timeout' },
      replies: [{ type: 'server-logs-match-text', seq: 1, text: logMatchText(1) }],
    }),
    // T1357: a service whose log has no line yet. `no-services` is the page with no service at all.
    variant('serverLogs', 'empty', () => logs(entry('api', '', { state: 'empty', message: 'api has not written to its log yet.' }))),
    variant('serverLogs', 'loading', LOADING),
    variant('serverLogs', 'error', () => logs(entry('api', '2026-01-01T00:00:00.000Z \u001b[31merror\u001b[0m ECONNREFUSED 127.0.0.1:5432\n'))),
    variant('serverLogs', 'long-content', () =>
      logs(
        entry('web-frontend-with-a-very-long-service-name-over-forty-chars', `2026-01-01T00:00:00.000Z ${'GET /very/long/path/segment/'.repeat(30)} 200\n`),
        entry('api', Array.from({ length: 400 }, (_, i) => line(i)).join('')),
      ),
    ),
    // T1317 LG-11: the same hostile line with Wrap off, so it scrolls inside the log host only (@ui:UI-R45).
    variant('serverLogs', 'long-content-nowrap', () =>
      logs(
        entry('web-frontend-with-a-very-long-service-name-over-forty-chars', `2026-01-01T00:00:00.000Z ${'GET /very/long/path/segment/'.repeat(30)} 200\n`),
        entry('api', Array.from({ length: 400 }, (_, i) => line(i)).join('')),
      ),
      { click: '[data-log-wrap]' },
    ),
    // T1317 LG-1: a log over the read cap opens at its newest output, with the skipped part named first.
    variant('serverLogs', 'truncated', () =>
      logs(entry('api', '[Earlier output not shown: 14.2 MB]\n' + Array.from({ length: 40 }, (_, i) => line(i)).join(''), { truncated: true })),
    ),
    // T1317 LG-8: no service at all, and a service whose log karst cannot read.
    variant('serverLogs', 'no-services', () => ({ messages: [{ type: 'server-logs', servers: [] }] })),
    variant('serverLogs', 'unreadable', () =>
      logs(entry('api', '', { state: 'unreadable', message: 'Karst cannot read /tmp/api.log.' })),
    ),
    variant('serverLogs', 'streaming', () => ({
      messages: [
        ...logs(entry('web', line(1))).messages,
        { type: 'server-log-output', service: 'web', text: line(2) + line(3) },
      ],
    })),
  ];
};
