import { describe, expect, it } from 'vitest';
import { lintDocMermaid, mermaidFences, parseMermaid } from './docsMermaid.mjs';

describe('mermaidFences', () => {
  it('extracts only mermaid fences, with their 1-based start line', () => {
    const text = 'intro\n```mermaid\nflowchart TD\n  A --> B\n```\n```js\nx\n```\n';
    expect(mermaidFences(text)).toEqual([{ line: 2, code: 'flowchart TD\n  A --> B' }]);
  });

  it('accepts tilde fences and ignores unterminated ones', () => {
    expect(mermaidFences('~~~mermaid\nsequenceDiagram\n  A->>B: hi\n~~~\n')).toEqual([
      { line: 1, code: 'sequenceDiagram\n  A->>B: hi' },
    ]);
    expect(mermaidFences('```mermaid\nflowchart TD\n')).toEqual([]);
  });
});

describe('parseMermaid', () => {
  it('parses a flowchart, a sequenceDiagram and an erDiagram', async () => {
    expect(await parseMermaid('flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Do]')).toBeNull();
    expect(await parseMermaid('sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi')).toBeNull();
    expect(await parseMermaid('erDiagram\n  CUSTOMER ||--o{ ORDER : places')).toBeNull();
  });

  it('returns the parse error for a malformed diagram', async () => {
    expect(await parseMermaid('flowchart TD\n  A --> ')).toMatch(/Parse error/);
  });
});

describe('lintDocMermaid', () => {
  it('passes good fixtures for each diagram type', async () => {
    const text = [
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      '```mermaid',
      'sequenceDiagram',
      '  A->>B: hi',
      '```',
      '```mermaid',
      'erDiagram',
      '  A ||--o{ B : has',
      '```',
    ].join('\n');
    expect(await lintDocMermaid({ path: 'docs/x.md', text })).toEqual([]);
  });

  it('reports a bad fence with its path and line', async () => {
    const text = 'text\n```mermaid\nsequenceDiagram\n  Alice->>Bob\n```\n';
    const errs = await lintDocMermaid({ path: 'docs/x.md', text });
    expect(errs.join()).toMatch(/docs\/x\.md:2: mermaid:/);
  });
});
