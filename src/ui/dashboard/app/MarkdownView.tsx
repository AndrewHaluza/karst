/**
 * A small, safe Markdown renderer for the ticket details drawer. It builds React elements ONLY (never
 * `dangerouslySetInnerHTML`), so brief text, which is provider or user data, can never become structure: HTML, script
 * tags and unknown syntax render as literal text. Subset: headings `#`-`####`, paragraphs, `-`/`*`/`1.` lists (one nesting
 * level), inline code, fenced code blocks, `**bold**`, `*em*` and `[text](url)` links. A link goes through `safeUrl`
 * (http(s) only); any other URL leaves the link text as plain text. The items of a `## Design constraints` section
 * render as mono chips.
 */
import { Fragment, type ReactNode } from 'react';
import { safeUrl } from '../../../integrations/attachmentMarkdown.js';
import { CONSTRAINTS_HEADING } from '../../../planning/constraintBrief.js';

type Block =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4; readonly text: string }
  | { readonly kind: 'para'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly ListItem[]; readonly chips: boolean };

interface ListItem {
  readonly text: string;
  readonly children: readonly string[];
}

const HEADING_RE = /^(#{1,4}) +([^ ].*|)$/;
const ITEM_RE = /^( *)([-*]|\d+\.) +([^ ].*|)$/;
const FENCE_RE = /^ {0,3}(`{3,})/;
const NEST_INDENT = 2;

/** The heading text without its trailing spaces and closing hashes, in linear time (a regex for it backtracks). */
function headingText(raw: string): string {
  let end = raw.length;
  while (end > 0 && /\s/.test(raw[end - 1]!)) end--;
  while (end > 0 && raw[end - 1] === '#') end--;
  while (end > 0 && /\s/.test(raw[end - 1]!)) end--;
  return raw.slice(0, end);
}

/** Blocks of the Markdown subset; every line no rule claims ends up in a paragraph as literal text. */
function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let inConstraints = false;
  const flush = (): void => {
    if (para.length) blocks.push({ kind: 'para', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!);
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length as 1 | 2 | 3 | 4;
      const text = headingText(heading[2]!);
      blocks.push({ kind: 'heading', level, text });
      inConstraints = `${heading[1]} ${text}` === CONSTRAINTS_HEADING;
      continue;
    }
    const item = ITEM_RE.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]!);
      const items: { text: string; children: string[] }[] = [];
      for (; i < lines.length; i++) {
        const m = ITEM_RE.exec(lines[i]!);
        if (!m) break;
        if (m[1]!.length >= NEST_INDENT && items.length) items[items.length - 1]!.children.push(m[3]!);
        else items.push({ text: m[3]!, children: [] });
      }
      i--;
      blocks.push({ kind: 'list', ordered, items, chips: inConstraints });
      continue;
    }
    if (line.trim() === '') flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}

/** Longest span an inline rule scans for its closer. The bound keeps an unclosed opener linear, not quadratic. */
const MAX_SPAN = 500;
const MAX_URL = 2000;
const INLINE_RE = new RegExp(
  `\`([^\`]{1,${MAX_SPAN}})\`|\\*\\*([^*]{1,${MAX_SPAN}})\\*\\*|\\*([^*\\s][^*]{0,${MAX_SPAN}})\\*|\\[([^\\]]{1,${MAX_SPAN}})\\]\\(([^)\\s]{1,${MAX_URL}})\\)`,
  'g',
);

/** One span of a text run as the scan finds it, before it becomes an element. */
export type InlineToken = { readonly at: number } & (
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'em'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly url: string }
);

/**
 * Inline tokens of one text run, in order. Pure and element-free, so a test can time the scan itself: a React render
 * would put jsdom cost into the number and hide the scan's own shape. `at` is the token's start offset in the run,
 * which is unique and stable, so it also serves as the React key.
 */
export function scanInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index;
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at), at: last });
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1], at });
    else if (m[2] !== undefined) out.push({ kind: 'strong', text: m[2], at });
    else if (m[3] !== undefined) out.push({ kind: 'em', text: m[3], at });
    else out.push({ kind: 'link', text: m[4]!, url: m[5]!, at });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last), at: last });
  return out;
}

/** Inline spans of one text run. Text no rule claims stays literal; React escapes it. */
function inline(text: string): ReactNode[] {
  return scanInline(text).map((token) => {
    const key = token.at;
    switch (token.kind) {
      case 'text':
        return token.text;
      case 'code':
        return <code key={key}>{token.text}</code>;
      case 'strong':
        return <strong key={key}>{token.text}</strong>;
      case 'em':
        return <em key={key}>{token.text}</em>;
      case 'link': {
        const href = safeUrl(token.url);
        return href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {token.text}
          </a>
        ) : (
          <Fragment key={key}>{token.text}</Fragment>
        );
      }
    }
  });
}

function ListView({ block }: { readonly block: Extract<Block, { kind: 'list' }> }) {
  const Tag = block.ordered ? 'ol' : 'ul';
  return (
    <Tag className={block.chips ? 'mdChips' : undefined}>
      {block.items.map((item, i) => (
        <li key={`b${i}`} className={block.chips ? 'k-chip mdChip' : undefined}>
          {inline(item.text)}
          {item.children.length ? (
            <ul>
              {item.children.map((child, j) => (
                <li key={`c${j}`}>{inline(child)}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </Tag>
  );
}

function BlockView({ block }: { readonly block: Block }) {
  switch (block.kind) {
    case 'heading': {
      // The drawer owns h1-h3; brief headings start at h4 so the page outline never inverts.
      const Tag = (['h4', 'h4', 'h5', 'h6'] as const)[block.level - 1]!;
      return <Tag className={`mdH${block.level}`}>{inline(block.text)}</Tag>;
    }
    case 'para':
      return <p>{inline(block.text)}</p>;
    case 'code':
      return (
        <pre className="mdCode">
          <code>{block.text}</code>
        </pre>
      );
    case 'list':
      return <ListView block={block} />;
  }
}

export function MarkdownView({ markdown, className }: { readonly markdown: string; readonly className?: string }) {
  const blocks = parseBlocks(markdown);
  return (
    <div className={`mdView${className ? ` ${className}` : ''}`}>
      {blocks.map((block, i) => (
        <BlockView key={`b${i}`} block={block} />
      ))}
    </div>
  );
}
