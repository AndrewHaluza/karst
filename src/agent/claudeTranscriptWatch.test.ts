import { describe, it, expect } from 'vitest';
import {
  resolveClaudeProjectsDir,
  encodeClaudeProjectDir,
  transcriptPathFor,
  parseClaudeTranscript,
  claudeTranscriptTick,
  type ClaudeWatchState,
} from './claudeTranscriptWatch.js';

// Verbatim transcript fixture shapes (JSONL). The actual uuid and counts are
// fabricated but the structure matches real Claude Code 2.1.231 output.
const ASSISTANT_LINE_1 = JSON.stringify({
  type: 'assistant',
  uuid: 'msg-00000001-aaaa-bbbb-cccc-dddddddddddd',
  message: {
    usage: {
      input_tokens: 1500,
      output_tokens: 200,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 100,
    },
  },
});

const USER_LINE = JSON.stringify({
  type: 'user',
  uuid: 'msg-00000002-aaaa-bbbb-cccc-dddddddddddd',
  message: { content: 'What is 2+2?' },
});

const LAST_PROMPT_LINE = JSON.stringify({
  type: 'last-prompt',
  uuid: 'msg-00000003-aaaa-bbbb-cccc-dddddddddddd',
});

const ASSISTANT_LINE_2 = JSON.stringify({
  type: 'assistant',
  uuid: 'msg-00000004-aaaa-bbbb-cccc-dddddddddddd',
  message: {
    usage: {
      input_tokens: 800,
      output_tokens: 50,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 0,
    },
  },
});

const TRUNCATED_LINE = '{"type":"assistant","uuid":';

const INVALID_COUNTER_LINE = JSON.stringify({
  type: 'assistant',
  uuid: 'msg-00000005-aaaa-bbbb-cccc-dddddddddddd',
  message: {
    usage: {
      input_tokens: 'lots',
      output_tokens: 10,
    },
  },
});

const MISSING_UUID_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    usage: {
      input_tokens: 100,
      output_tokens: 20,
    },
  },
});

describe('claudeTranscriptWatch', () => {
  describe('resolveClaudeProjectsDir', () => {
    it('honors CLAUDE_CONFIG_DIR override', () => {
      expect(resolveClaudeProjectsDir({ CLAUDE_CONFIG_DIR: '/custom/claude' }, '/home/u')).toBe(
        '/custom/claude/projects',
      );
    });

    it('defaults to ~/.claude/projects', () => {
      expect(resolveClaudeProjectsDir({}, '/home/u')).toBe('/home/u/.claude/projects');
    });
  });

  describe('encodeClaudeProjectDir', () => {
    it('encodes the base repo path', () => {
      expect(encodeClaudeProjectDir('/Users/nd/Work/projects/karst')).toBe(
        '-Users-nd-Work-projects-karst',
      );
    });

    it('encodes a worktree path', () => {
      expect(
        encodeClaudeProjectDir(
          '/Users/nd/Work/projects/karst/.karst/worktrees/869e48tv6-feat-something',
        ),
      ).toBe('-Users-nd-Work-projects-karst--karst-worktrees-869e48tv6-feat-something');
    });
  });

  describe('transcriptPathFor', () => {
    it('joins projectsDir, encoded cwd, and sessionId.jsonl', () => {
      expect(
        transcriptPathFor(
          '/home/u/.claude/projects',
          '/Users/nd/Work/projects/karst',
          'abc-123',
        ),
      ).toBe('/home/u/.claude/projects/-Users-nd-Work-projects-karst/abc-123.jsonl');
    });
  });

  describe('parseClaudeTranscript', () => {
    it('returns null for empty string', () => {
      expect(parseClaudeTranscript('')).toBeNull();
    });

    it('returns null when only non-assistant lines exist', () => {
      expect(parseClaudeTranscript([USER_LINE, LAST_PROMPT_LINE].join('\n'))).toBeNull();
    });

    it('returns null when usage is absent on assistant lines', () => {
      const noUsage = JSON.stringify({ type: 'assistant', uuid: 'x' });
      expect(parseClaudeTranscript(noUsage)).toBeNull();
    });

    it('returns null when uuid is missing', () => {
      expect(parseClaudeTranscript(MISSING_UUID_LINE)).toBeNull();
    });

    it('parses a multi-line transcript with two assistant messages', () => {
      const text = [ASSISTANT_LINE_1, USER_LINE, LAST_PROMPT_LINE, ASSISTANT_LINE_2].join('\n');
      const result = parseClaudeTranscript(text);
      expect(result).toEqual({
        eventId: 'msg-00000004-aaaa-bbbb-cccc-dddddddddddd',
        input: 2300, // 1500 + 800
        output: 250, // 200 + 50
        cacheRead: 1200, // 500 + 700
        cacheWrite: 100, // 100 + 0
      });
    });

    it('skips truncated/unparseable lines but still parses valid ones', () => {
      const text = [ASSISTANT_LINE_1, TRUNCATED_LINE, ASSISTANT_LINE_2].join('\n');
      const result = parseClaudeTranscript(text);
      expect(result).not.toBeNull();
      expect(result!.input).toBe(2300);
    });

    it('skips a message with a present-but-invalid counter', () => {
      const text = [INVALID_COUNTER_LINE, ASSISTANT_LINE_2].join('\n');
      const result = parseClaudeTranscript(text);
      expect(result).not.toBeNull();
      // The invalid message was skipped; only ASSISTANT_LINE_2 contributes.
      expect(result!.input).toBe(800);
      expect(result!.output).toBe(50);
      expect(result!.eventId).toBe('msg-00000004-aaaa-bbbb-cccc-dddddddddddd');
    });
  });

  describe('claudeTranscriptTick', () => {
    const freshState = (): ClaudeWatchState => ({
      transcriptPath: null,
      eventId: null,
      fingerprint: null,
    });

    it('returns [] for null snapshot', () => {
      const state = freshState();
      expect(claudeTranscriptTick(state, null)).toEqual([]);
      expect(state.eventId).toBeNull();
    });

    it('emits one UsageUpdate on first observation', () => {
      const state = freshState();
      const events = claudeTranscriptTick(state, {
        transcriptPath: '/path/to/transcript.jsonl',
        usage: {
          eventId: 'msg-00000001',
          input: 1500,
          output: 200,
          cacheRead: 500,
          cacheWrite: 100,
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: 'UsageUpdate',
        usage: {
          event_id: 'msg-00000001',
          input: 1500,
          output: 200,
          cache_read: 500,
          cache_write: 100,
        },
      });
      expect(state.eventId).toBe('msg-00000001');
    });

    it('returns [] when the same usage is observed again', () => {
      const state = freshState();
      const snapshot = {
        transcriptPath: '/path/to/transcript.jsonl',
        usage: {
          eventId: 'msg-00000001',
          input: 1500,
          output: 200,
          cacheRead: 500,
          cacheWrite: 100,
        },
      };
      claudeTranscriptTick(state, snapshot);
      const events = claudeTranscriptTick(state, snapshot);
      expect(events).toEqual([]);
    });

    it('emits one event with new cumulative numbers on a later message', () => {
      const state = freshState();
      const path = '/path/to/transcript.jsonl';
      claudeTranscriptTick(state, {
        transcriptPath: path,
        usage: {
          eventId: 'msg-00000001',
          input: 1500,
          output: 200,
          cacheRead: 500,
          cacheWrite: 100,
        },
      });
      const events = claudeTranscriptTick(state, {
        transcriptPath: path,
        usage: {
          eventId: 'msg-00000004',
          input: 2300,
          output: 250,
          cacheRead: 1200,
          cacheWrite: 100,
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: 'UsageUpdate',
        usage: {
          event_id: 'msg-00000004',
          input: 2300,
          output: 250,
          cache_read: 1200,
          cache_write: 100,
        },
      });
      expect(state.eventId).toBe('msg-00000004');
    });

    it('resets state when the transcript path changes (new session)', () => {
      const state = freshState();
      claudeTranscriptTick(state, {
        transcriptPath: '/path/to/old.jsonl',
        usage: {
          eventId: 'msg-00000001',
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
        },
      });
      const events = claudeTranscriptTick(state, {
        transcriptPath: '/path/to/new.jsonl',
        usage: {
          eventId: 'msg-00000001',
          input: 200,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
        },
      });
      // Same eventId but different path → new session, emits the event.
      expect(events).toHaveLength(1);
      expect(state.transcriptPath).toBe('/path/to/new.jsonl');
    });

    it('returns [] when usage is null on a valid snapshot', () => {
      const state = freshState();
      const events = claudeTranscriptTick(state, {
        transcriptPath: '/path/to/transcript.jsonl',
        usage: null,
      });
      expect(events).toEqual([]);
      expect(state.eventId).toBeNull();
    });
  });
});
