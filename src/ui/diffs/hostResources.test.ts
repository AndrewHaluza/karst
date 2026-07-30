import { describe, expect, it, vi } from 'vitest';
import { DisposableBag, VirtualDocumentRegistry } from './hostResources.js';

describe('VirtualDocumentRegistry', () => {
  it('rolls back every virtual document created by a failed open attempt', () => {
    const documents = new VirtualDocumentRegistry();
    const attempt = documents.beginAttempt();
    attempt.set('karst-diff:/1/left.ts', 'left secret');
    attempt.set('karst-diff:/2/right.ts', 'right secret');

    attempt.rollback();

    expect(documents.get('karst-diff:/1/left.ts')).toBeUndefined();
    expect(documents.get('karst-diff:/2/right.ts')).toBeUndefined();
  });

  it('keeps committed documents until their document-close cleanup', () => {
    const documents = new VirtualDocumentRegistry();
    const attempt = documents.beginAttempt();
    attempt.set('karst-diff:/1/file.ts', 'prepared content');

    attempt.commit();
    attempt.rollback();

    expect(documents.get('karst-diff:/1/file.ts')).toBe('prepared content');
    documents.delete('karst-diff:/1/file.ts');
    expect(documents.get('karst-diff:/1/file.ts')).toBeUndefined();
  });
});

describe('DisposableBag', () => {
  it('releases panel listeners exactly once and immediately releases late additions', () => {
    const first = { dispose: vi.fn() };
    const second = { dispose: vi.fn() };
    const late = { dispose: vi.fn() };
    const listeners = new DisposableBag();
    listeners.add(first);
    listeners.add(second);

    listeners.dispose();
    listeners.dispose();
    listeners.add(late);

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(late.dispose).toHaveBeenCalledOnce();
  });
});
