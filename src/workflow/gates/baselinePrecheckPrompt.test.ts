import { describe, it, expect } from 'vitest';
import {
  buildBaselinePrecheckPrompt,
  parseBaselinePrecheckAnswer,
  type BaselinePrecheckTarget,
} from './baselinePrecheckPrompt.js';

function target(over: Partial<BaselinePrecheckTarget> & Pick<BaselinePrecheckTarget, 'label'>): BaselinePrecheckTarget {
  return {
    repo: 'web',
    path: 'a.png',
    status: 'modified',
    newSha256: 'sha-a',
    oldImagePath: '/tmp/old/a.png',
    newImagePath: '/wt/web/a.png',
    ...over,
  };
}

describe('parseBaselinePrecheckAnswer', () => {
  const labels = ['web:a.png', 'web:b.png', 'web:c.png'];

  it('reads approvals with their trimmed reason', () => {
    const parsed = parseBaselinePrecheckAnswer(
      JSON.stringify({ entries: [{ path: 'web:a.png', verdict: 'approve', reason: '  moved right  ' }] }),
      labels,
    );
    expect(parsed?.get('web:a.png')).toBe('moved right');
  });

  it('never approves a human verdict', () => {
    const parsed = parseBaselinePrecheckAnswer(
      JSON.stringify({ entries: [{ path: 'web:a.png', verdict: 'human', reason: 'unclear' }] }),
      labels,
    );
    expect(parsed?.has('web:a.png')).toBe(false);
  });

  it('never approves an empty reason', () => {
    const parsed = parseBaselinePrecheckAnswer(
      JSON.stringify({ entries: [{ path: 'web:a.png', verdict: 'approve', reason: '   ' }] }),
      labels,
    );
    expect(parsed?.has('web:a.png')).toBe(false);
  });

  it('ignores an unknown path', () => {
    const parsed = parseBaselinePrecheckAnswer(
      JSON.stringify({ entries: [{ path: '../escape.png', verdict: 'approve', reason: 'x' }] }),
      labels,
    );
    expect([...(parsed?.keys() ?? [])]).toEqual([]);
  });

  it('approves neither copy of a duplicate path', () => {
    const parsed = parseBaselinePrecheckAnswer(
      JSON.stringify({
        entries: [
          { path: 'web:a.png', verdict: 'approve', reason: 'one' },
          { path: 'web:a.png', verdict: 'approve', reason: 'two' },
        ],
      }),
      labels,
    );
    expect(parsed?.has('web:a.png')).toBe(false);
  });

  it('leaves a missing entry unapproved', () => {
    const parsed = parseBaselinePrecheckAnswer(
      JSON.stringify({ entries: [{ path: 'web:a.png', verdict: 'approve', reason: 'x' }] }),
      labels,
    );
    expect(parsed?.has('web:b.png')).toBe(false);
  });

  it('reads a fenced JSON document', () => {
    const parsed = parseBaselinePrecheckAnswer(
      '```json\n{"entries":[{"path":"web:a.png","verdict":"approve","reason":"ok"}]}\n```',
      labels,
    );
    expect(parsed?.get('web:a.png')).toBe('ok');
  });

  it('reads the JSON object from a final message wrapped in prose (antigravity shape)', () => {
    const message = [
      'I looked at both images for the save button change.',
      '',
      '{"entries":[{"path":"web:a.png","verdict":"approve","reason":"button moved right"}]}',
      '',
      'That is my review.',
    ].join('\n');
    const parsed = parseBaselinePrecheckAnswer(message, labels, message);
    expect(parsed?.get('web:a.png')).toBe('button moved right');
  });

  it('reads the JSON object from a fenced block surrounded by prose (opencode shape)', () => {
    const message = [
      'Here is the review:',
      '```json',
      '{"entries":[{"path":"web:b.png","verdict":"approve","reason":"intended"}]}',
      '```',
    ].join('\n');
    const parsed = parseBaselinePrecheckAnswer('streamed narration', labels, message);
    expect(parsed?.get('web:b.png')).toBe('intended');
  });

  it('prefers a shaped answer over an unrelated JSON object in the same message', () => {
    const parsed = parseBaselinePrecheckAnswer(
      '{"type":"session","meta":{"tool":"read"}} {"entries":[{"path":"web:c.png","verdict":"approve","reason":"ok"}]}',
      labels,
    );
    expect(parsed?.get('web:c.png')).toBe('ok');
  });

  it('falls back to the core final message when the raw stream is unreadable', () => {
    const parsed = parseBaselinePrecheckAnswer(
      'narration only',
      labels,
      JSON.stringify({ entries: [{ path: 'web:a.png', verdict: 'approve', reason: 'ok' }] }),
    );
    expect(parsed?.get('web:a.png')).toBe('ok');
  });

  it('is unreadable for prose and a wrong shape', () => {
    expect(parseBaselinePrecheckAnswer('looks fine to me', labels)).toBeNull();
    expect(parseBaselinePrecheckAnswer('{"findings":[]}', labels)).toBeNull();
    expect(parseBaselinePrecheckAnswer('', labels)).toBeNull();
  });
});

describe('buildBaselinePrecheckPrompt', () => {
  it('carries the ticket intent, the UI paths and every entry with both image paths', () => {
    const prompt = buildBaselinePrecheckPrompt({
      ticket: { title: 'Move the save button', description: 'The save button moves right.', brief: 'Settings only.' },
      uiPaths: ['src/ui/settings/app/Save.tsx'],
      targets: [
        target({
          label: 'web:tests/visual/__baselines__/save.png',
          path: 'tests/visual/__baselines__/save.png',
          oldImagePath: '/tmp/run/old/tests/visual/__baselines__/save.png',
          newImagePath: '/wt/web/tests/visual/__baselines__/save.png',
        }),
        target({
          label: 'web:tests/visual/__baselines__/new.png',
          path: 'tests/visual/__baselines__/new.png',
          status: 'added',
          oldImagePath: null,
          newImagePath: '/wt/web/tests/visual/__baselines__/new.png',
        }),
      ],
    });
    expect(prompt).toContain('Move the save button');
    expect(prompt).toContain('The save button moves right.');
    expect(prompt).toContain('Settings only.');
    expect(prompt).toContain('src/ui/settings/app/Save.tsx');
    expect(prompt).toContain('web:tests/visual/__baselines__/save.png');
    expect(prompt).toContain('/tmp/run/old/tests/visual/__baselines__/save.png');
    expect(prompt).toContain('/wt/web/tests/visual/__baselines__/save.png');
    expect(prompt).toContain('web:tests/visual/__baselines__/new.png');
    // The added entry names no old image.
    const addedLine = prompt.split('\n').find((l) => l.includes('web:tests/visual/__baselines__/new.png'))!;
    expect(addedLine).not.toContain('/tmp/run/old');
    // The two verdicts and the JSON answer shape are stated.
    expect(prompt).toContain('"approve"');
    expect(prompt).toContain('"human"');
    expect(prompt).toContain('"verdict"');
  });

  it('names no core-specific tool and tells the model to open each image and look at it', () => {
    const prompt = buildBaselinePrecheckPrompt({
      ticket: { title: 't', description: '', brief: '' },
      uiPaths: [],
      targets: [target({ label: 'web:a.png' })],
    });
    expect(prompt).not.toContain('Read tool');
    expect(prompt).toContain('open EACH image file below and look at it');
  });

  it('rules that an image whose pixels cannot be seen answers "human"', () => {
    const prompt = buildBaselinePrecheckPrompt({
      ticket: { title: 't', description: '', brief: '' },
      uiPaths: [],
      targets: [target({ label: 'web:a.png' })],
    });
    expect(prompt).toContain('If you cannot see the pixels of an image, answer "human" for that entry.');
  });

  it('bounds an oversized ticket description', () => {
    const prompt = buildBaselinePrecheckPrompt({
      ticket: { title: 't', description: 'x'.repeat(20_000), brief: '' },
      uiPaths: [],
      targets: [target({ label: 'web:a.png' })],
    });
    expect(prompt).toContain('[truncated at 6000 characters]');
    expect(prompt.length).toBeLessThan(20_000);
  });
});
