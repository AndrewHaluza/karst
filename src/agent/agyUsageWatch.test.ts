import { describe, it, expect } from 'vitest';
import {
  parseStepUsage,
  aggregateConversationUsage,
  agyUsageTick,
  type AgyUsageState,
} from './agyUsageWatch.js';

// Verbatim fixture bytes from a real agy 1.1.12 conversation DB
// (conversation b9722f2f-3831-4c77-9167-c14fb5342645, which reported
// input=9836, output=292, thinking=283, cache_read=8110, total=10128).

// idx=3, step_type=15 (main generation): input 9737, output 288, cache_read 8110
const TYPE15_METADATA = Buffer.from(
  '0a0b08d1e4f6d30610b0bde30e1802320c08d6e4f6d30610a8ce9efd013a0c08d6e4f6d30610f0aca6b302420c08d6e4f6d30610f0aca6b3024a4f088c0810894c18a00228ae3f301842210a0973657373696f6e494412142d33373530373633303334333632383935353739489b0250055a1755624a39616f6948494c434632386f5076365063734138588c08622430306366303937322d316631372d343865322d383263612d3663616237616230326433636a03088c08a2014e0a2434326636386230342d633632632d346638382d396365642d6264346139316564393763361003222462393732326632662d333833312d346337372d393136372d633134666235333432363435a80101d201240a100808120c08d6e4f6d3061080ffa0fd010a100803120c08d6e4f6d30610f8caa9b30282020c08d6e4f6d30610f0aca6b302',
  'hex',
);

// idx=4, step_type=23 (secondary model call): input 99, output 4, cache_read 0
const TYPE23_METADATA = Buffer.from(
  '0a0c08d6e4f6d30610c0ec90b5021805420b08d7e4f6d3061088f1b8704a47089a0810631804301842210a0973657373696f6e494412142d3337353037363330333433363238393535373950045a1756724a3961765f624c347162766449506f724834734134622430306366303937322d316631372d343865322d383263612d366361623761623032643363a201500a2434326636386230342d633632632d346638382d396365642d62643461393165643937633610041801222462393732326632662d333833312d346337372d393136372d633134666235333432363435d201350a100801120c08d6e4f6d30610e08b91b5020a100802120c08d6e4f6d30610d8a5a5b5020a0f0803120b08d7e4f6d30610f89fb970e201491247089a0810631804301842210a0973657373696f6e494412142d3337353037363330333433363238393535373950045a1756724a3961765f624c347162766449506f72483473413482020c08d6e4f6d3061098fc9db502',
  'hex',
);

// A non-model step blob (no field-9 submessage)
const NON_MODEL_METADATA = Buffer.from('0a0b08d1e4f6d30610d0dfe50d1805', 'hex');

describe('agyUsageWatch', () => {
  describe('parseStepUsage', () => {
    it('returns null for null metadata', () => {
      expect(parseStepUsage(null)).toBeNull();
    });

    it('returns null for a non-model blob with no field-9 tag', () => {
      expect(parseStepUsage(NON_MODEL_METADATA)).toBeNull();
    });

    it('parses a type-15 (main generation) step', () => {
      const result = parseStepUsage(TYPE15_METADATA);
      expect(result).toEqual({ input: 9737, output: 288, cacheRead: 8110 });
    });

    it('parses a type-23 (secondary model call) step', () => {
      const result = parseStepUsage(TYPE23_METADATA);
      expect(result).toEqual({ input: 99, output: 4, cacheRead: 0 });
    });
  });

  describe('aggregateConversationUsage', () => {
    it('sums both step types into cumulative usage', () => {
      const result = aggregateConversationUsage([
        { idx: 3, metadata: TYPE15_METADATA },
        { idx: 4, metadata: TYPE23_METADATA },
      ]);
      expect(result).toEqual({
        input: 9836,
        output: 292,
        cacheRead: 8110,
        lastStepIdx: 4,
      });
    });

    it('returns null for an empty row set', () => {
      expect(aggregateConversationUsage([])).toBeNull();
    });

    it('returns null when no step has a field-9 submessage', () => {
      expect(
        aggregateConversationUsage([
          { idx: 0, metadata: NON_MODEL_METADATA },
        ]),
      ).toBeNull();
    });
  });

  describe('agyUsageTick', () => {
    const freshState = (): AgyUsageState => ({ eventId: null });

    it('returns [] when usage is null', () => {
      const state = freshState();
      expect(agyUsageTick(state, null)).toEqual([]);
      expect(state.eventId).toBeNull();
    });

    it('emits one UsageUpdate on first observation', () => {
      const state = freshState();
      const usage = {
        input: 9836,
        output: 292,
        cacheRead: 8110,
        lastStepIdx: 4,
      };
      const events = agyUsageTick(state, usage);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: 'UsageUpdate',
        usage: {
          event_id: '4',
          input: 9836,
          output: 292,
          cache_read: 8110,
          total: 10128,
        },
      });
      expect(state.eventId).toBe('4');
    });

    it('returns [] when the same usage is observed again', () => {
      const state = freshState();
      const usage = {
        input: 9836,
        output: 292,
        cacheRead: 8110,
        lastStepIdx: 4,
      };
      agyUsageTick(state, usage); // first observation
      const events = agyUsageTick(state, usage); // same idx
      expect(events).toEqual([]);
    });

    it('emits one event with new cumulative numbers on a later step', () => {
      const state = freshState();
      agyUsageTick(state, {
        input: 9836,
        output: 292,
        cacheRead: 8110,
        lastStepIdx: 4,
      });
      const events = agyUsageTick(state, {
        input: 10412,
        output: 402,
        cacheRead: 8111,
        lastStepIdx: 6,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: 'UsageUpdate',
        usage: {
          event_id: '6',
          input: 10412,
          output: 402,
          cache_read: 8111,
          total: 10814,
        },
      });
      expect(state.eventId).toBe('6');
    });
  });
});
