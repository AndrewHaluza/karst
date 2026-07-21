import { describe, it, expect } from 'vitest';
import { renderAttachmentSection } from './attachmentMarkdown.js';

describe('renderAttachmentSection', () => {
  it('renders nothing for zero attachments', () => {
    expect(renderAttachmentSection([])).toEqual([]);
  });

  it('renders an image as a markdown image reference', () => {
    const md = renderAttachmentSection([
      { name: 'shot.png', url: 'https://files/shot.png', kind: 'image', mimeType: 'image/png', size: 1024 },
    ]).join('\n');
    expect(md).toContain('## Attachments');
    expect(md).toContain('![shot.png](https://files/shot.png)');
  });

  it('inlines text content in a fenced block', () => {
    const md = renderAttachmentSection([
      { name: 'notes.md', url: 'https://files/notes.md', kind: 'text', content: '# Hi\nthere' },
    ]).join('\n');
    expect(md).toContain('```');
    expect(md).toContain('# Hi\nthere');
  });

  it('lengthens the fence when the content contains one', () => {
    const md = renderAttachmentSection([
      { name: 'a.md', url: 'https://f/a.md', kind: 'text', content: '```js\nx\n```' },
    ]).join('\n');
    expect(md).toContain('````');
    expect(md).toContain('```js\nx\n```');
  });

  it('notes truncation', () => {
    const md = renderAttachmentSection([
      { name: 'big.log', url: 'https://f/big.log', kind: 'text', content: 'x', truncated: true, size: 99999 },
    ]).join('\n');
    expect(md.toLowerCase()).toContain('truncated');
  });

  it('renders a binary attachment as a labeled link with type and size', () => {
    const md = renderAttachmentSection([
      { name: 'app.zip', url: 'https://f/app.zip', kind: 'binary', mimeType: 'application/zip', size: 2048 },
    ]).join('\n');
    expect(md).toContain('[app.zip](https://f/app.zip)');
    expect(md).toContain('application/zip');
    expect(md).toContain('2.0 KB');
  });

  it('marks an unavailable attachment without dropping it', () => {
    const md = renderAttachmentSection([
      { name: 'x.pdf', url: 'https://f/x.pdf', kind: 'unavailable', error: 'download returned 403' },
    ]).join('\n');
    expect(md).toContain('x.pdf');
    expect(md.toLowerCase()).toContain('unavailable');
    expect(md).toContain('403');
  });

  it('strips query strings so signed URLs never reach the brief', () => {
    const md = renderAttachmentSection([
      {
        name: 'shot.png',
        url: 'https://f/shot.png?X-Amz-Signature=deadbeef&token=secret',
        kind: 'image',
      },
    ]).join('\n');
    expect(md).not.toContain('deadbeef');
    expect(md).not.toContain('secret');
    expect(md).toContain('https://f/shot.png');
  });

  it('escapes filenames so they cannot break the markdown structure', () => {
    const md = renderAttachmentSection([
      { name: '## evil](javascript:x) [name\nnewline', url: 'https://f/a', kind: 'binary' },
    ]).join('\n');
    expect(md).not.toContain('](javascript:x)');
    expect(md).not.toMatch(/^## evil/m);
    expect(md).not.toContain('name\nnewline');
  });

  it('drops a url with a non-http scheme', () => {
    const md = renderAttachmentSection([
      { name: 'a.png', url: 'javascript:alert(1)', kind: 'image' },
    ]).join('\n');
    expect(md).not.toContain('javascript:');
  });
});
