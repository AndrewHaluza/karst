/**
 * Collects the text events of an opencode / opencode2 JSONL stream. `raw` joins
 * every text part (narration between tool calls included). `finalMessage` is the
 * text of the LAST assistant message that has text, grouped by the part's
 * `messageID`. A part with no `messageID` shares one anonymous group.
 */
export interface OpencodeTextCollector {
  add(part: Record<string, unknown>): void;
  result(): { raw: string; finalMessage?: string };
}

export function createOpencodeTextCollector(): OpencodeTextCollector {
  let raw = '';
  let lastId: string | undefined;
  let last = '';
  return {
    add(part) {
      const text = part['text'];
      if (typeof text !== 'string') return;
      raw += text;
      const id = typeof part['messageID'] === 'string' ? part['messageID'] : '';
      if (id !== lastId) {
        // A new message starts only when it carries visible text, so an empty
        // trailing message does not hide the real final answer.
        if (text.trim() === '') return;
        lastId = id;
        last = '';
      }
      last += text;
    },
    result() {
      return last.trim() === '' ? { raw } : { raw, finalMessage: last };
    },
  };
}
