import { describe, it, expect } from 'vitest';
import {
  StreamingConsoleFormat,
  opencodeConsoleLine,
  codexConsoleLine,
  consoleLineRendererFor,
  renderAgentMessage,
} from './consoleFormat.js';

describe('claude console output', () => {
  it('renders only the readable result from the final JSON envelope', () => {
    const line = JSON.stringify({
      is_error: false,
      duration_api_ms: 114_882,
      session_id: 'ed2ecfaf-3677-4af2-a3e4-3b6b5559bbb4',
      total_cost_usd: 1.91,
      usage: { input_tokens: 32, cache_read_input_tokens: 1_481_107 },
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_1' }],
      result: '[\n  { "severity": "high", "title": "Reasoning tokens are dropped" }\n]',
    });

    expect(consoleLineRendererFor('claude')?.(line)).toBe(
      '── Findings: 1 high ──\n\n[HIGH] Reasoning tokens are dropped\n',
    );
  });

  it('preserves malformed output so provider failures remain diagnosable', () => {
    expect(consoleLineRendererFor('claude')?.('not json')).toBe('not json\n');
  });

  it.each([
    ['empty result', { session_id: 's', usage: { input_tokens: 1 }, result: '' }],
    ['missing result', { session_id: 's', usage: { input_tokens: 1 } }],
  ])('does not expose metadata from a valid envelope with %s', (_label, envelope) => {
    expect(consoleLineRendererFor('claude')?.(JSON.stringify(envelope))).toBe('');
  });
});

describe('opencodeConsoleLine', () => {
  it('passes non-JSON prose through verbatim with its newline', () => {
    expect(opencodeConsoleLine('npm run test')).toBe('npm run test\n');
  });

  it('renders a text event as its text', () => {
    const line = JSON.stringify({
      type: 'text',
      sessionID: 'ses_1',
      part: { type: 'text', text: 'Checking the worktree state.' },
    });
    expect(opencodeConsoleLine(line)).toBe('Checking the worktree state.\n');
  });

  it('renders a completed bash tool use as the command plus its output', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_1',
      part: {
        type: 'tool',
        tool: 'bash',
        state: {
          status: 'completed',
          input: { command: 'git status --short' },
          output: ' M src/agent/opencode.ts\n',
        },
      },
    });
    expect(opencodeConsoleLine(line)).toBe('$ git status --short\n M src/agent/opencode.ts\n');
  });

  it('renders a bash tool use with no output as just the command', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_1',
      part: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'true' } },
      },
    });
    expect(opencodeConsoleLine(line)).toBe('$ true\n');
  });

  it('marks a failed bash tool use', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_1',
      part: {
        type: 'tool',
        tool: 'bash',
        state: { status: 'error', input: { command: 'npm run broken' } },
      },
    });
    expect(opencodeConsoleLine(line)).toBe('$ npm run broken  ✗\n');
  });

  it('renders a non-bash tool as a bare marker', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses_1',
      part: { type: 'tool', tool: 'read', state: {} },
    });
    expect(opencodeConsoleLine(line)).toBe('▶ read\n');
  });

  it('drops step_start and step_finish envelope noise', () => {
    const start = JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } });
    const finish = JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish' } });
    expect(opencodeConsoleLine(start)).toBe('');
    expect(opencodeConsoleLine(finish)).toBe('');
  });

  it('renders an error event as a failure line', () => {
    const line = JSON.stringify({
      type: 'error',
      sessionID: 'ses_1',
      error: { message: 'model quota exceeded' },
    });
    expect(opencodeConsoleLine(line)).toBe('✗ model quota exceeded\n');
  });

  it('passes an unknown event type through rather than silently dropping it', () => {
    const line = JSON.stringify({ type: 'usage', sessionID: 'ses_1', usage: {} });
    expect(opencodeConsoleLine(line)).toBe(`${line}\n`);
  });
});

describe('codexConsoleLine', () => {
  it('passes non-JSON prose through verbatim with its newline', () => {
    expect(codexConsoleLine('plain log line')).toBe('plain log line\n');
  });

  it('renders an agent_message item as its text', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Looks good to me.' },
    });
    expect(codexConsoleLine(line)).toBe('Looks good to me.\n');
  });

  it('renders a local_shell_call item as a command', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'local_shell_call', command: 'npm run typecheck' },
    });
    expect(codexConsoleLine(line)).toBe('$ npm run typecheck\n');
  });

  it('renders a tool_call item as a marker with its function name', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'tool_call', function: { name: 'view_file', arguments: '{"file":"a.ts"}' } },
    });
    expect(codexConsoleLine(line)).toBe('▶ view_file {"file":"a.ts"}\n');
  });

  it('drops thread/turn envelope events', () => {
    expect(codexConsoleLine('{"type":"thread.started","thread_id":"t"}')).toBe('');
    expect(codexConsoleLine('{"type":"turn.completed","usage":{}}')).toBe('');
  });

  it('renders turn.failed as a failure line', () => {
    const line = JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } });
    expect(codexConsoleLine(line)).toBe('✗ boom\n');
  });
});

describe('StreamingConsoleFormat', () => {
  const format = (): StreamingConsoleFormat => new StreamingConsoleFormat(opencodeConsoleLine);

  it('splits one chunk into its lines and renders each', () => {
    const f = format();
    const text = [
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'one' } }),
      JSON.stringify({ type: 'text', part: { type: 'text', text: 'two' } }),
      '',
    ].join('\n');
    expect(f.append('stdout', text)).toBe('one\ntwo\n');
    expect(f.flush('stdout')).toBe('');
  });

  it('buffers a partial line across chunks and renders it once complete', () => {
    const f = format();
    const json = JSON.stringify({ type: 'text', part: { type: 'text', text: 'split' } });
    const half = json.slice(0, Math.floor(json.length / 2));
    expect(f.append('stdout', half)).toBe('');
    expect(f.append('stdout', json.slice(half.length) + '\n')).toBe('split\n');
  });

  it('flushes a trailing line that never got a newline', () => {
    const f = format();
    const json = JSON.stringify({ type: 'text', part: { type: 'text', text: 'tail' } });
    expect(f.append('stdout', json)).toBe('');
    expect(f.flush('stdout')).toBe('tail\n');
  });

  it('keeps stdout and stderr buffers separate', () => {
    const f = format();
    f.append('stderr', 'warn');
    expect(f.append('stdout', JSON.stringify({ type: 'text', part: { type: 'text', text: 'ok' } }) + '\n')).toBe('ok\n');
    // stderr never received its newline; the stdout flush must not carry it.
    expect(f.flush('stdout')).toBe('');
    expect(f.flush('stderr')).toBe('warn\n');
  });
});

const DRIFT = {
  severity: 'high',
  title: 'vitestGate drift: unit config no longer excludes integration suffix',
  file: 'src/workflow/gates/vitestGate.ts',
  line: 42,
  detail: 'Line one.\nLine two.',
};
const COVERAGE = { severity: 'info', title: 'COVERAGE: no new uncovered branches' };
const RENDERED =
  '── Findings: 1 high, 1 info ──\n\n' +
  '[HIGH] vitestGate drift: unit config no longer excludes integration suffix\n' +
  '  at src/workflow/gates/vitestGate.ts:42\n' +
  '  Line one.\n  Line two.\n\n' +
  '[INFO] COVERAGE: no new uncovered branches';

describe('renderAgentMessage', () => {
  it('renders a whole-doc findings object', () => {
    expect(renderAgentMessage(JSON.stringify({ findings: [DRIFT, COVERAGE] }))).toBe(RENDERED);
  });
  it('renders a bare array carrying severity + title', () => {
    expect(renderAgentMessage(JSON.stringify([DRIFT, COVERAGE]))).toBe(RENDERED);
  });
  it('renders a fenced block and keeps surrounding prose', () => {
    const text = `Done.\n\`\`\`json\n${JSON.stringify({ findings: [DRIFT, COVERAGE] })}\n\`\`\`\nBye.`;
    expect(renderAgentMessage(text)).toBe(`Done.\n${RENDERED}\nBye.`);
  });
  it('omits at-line when file is missing and :line when line is missing', () => {
    expect(renderAgentMessage(JSON.stringify([{ severity: 'low', title: 'T', line: 3 }]))).toBe(
      '── Findings: 1 low ──\n\n[LOW] T',
    );
    expect(renderAgentMessage(JSON.stringify([{ severity: 'low', title: 'T', file: 'a.ts' }]))).toContain('  at a.ts');
    expect(renderAgentMessage(JSON.stringify([{ severity: 'low', title: 'T', file: 'a.ts' }]))).not.toContain('a.ts:');
  });
  it.each([
    ['plain prose', 'all good'],
    ['malformed JSON', '{"findings":[{"severity":'],
    ['object without findings', '{"ok":true}'],
    ['no valid finding', '{"findings":[{"severity":1,"title":2}]}'],
    ['empty findings', '{"findings":[]}'],
  ])('leaves %s unchanged', (_l, text) => {
    expect(renderAgentMessage(text)).toBe(text);
  });
  it('skips non-string fields defensively', () => {
    expect(renderAgentMessage(JSON.stringify([{ severity: 'low', title: 'T', file: 5, detail: {} }]))).toBe(
      '── Findings: 1 low ──\n\n[LOW] T',
    );
  });
});

describe('provider renderers format findings', () => {
  const doc = JSON.stringify({ findings: [DRIFT, COVERAGE] });
  it('claude', () => {
    expect(claudeLine(JSON.stringify({ result: doc }))).toBe(`${RENDERED}\n`);
  });
  it('opencode text', () => {
    expect(opencodeConsoleLine(JSON.stringify({ type: 'text', part: { text: doc } }))).toBe(`${RENDERED}\n`);
  });
  it('codex agent_message', () => {
    const ev = { type: 'item.completed', item: { type: 'agent_message', text: doc } };
    expect(codexConsoleLine(JSON.stringify(ev))).toBe(`${RENDERED}\n`);
  });
});

function claudeLine(line: string): string {
  return consoleLineRendererFor('claude')!(line);
}
