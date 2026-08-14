import { describe, it, expect } from 'vitest';
import {
  StreamingConsoleFormat,
  opencodeConsoleLine,
  codexConsoleLine,
} from './consoleFormat.js';

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
