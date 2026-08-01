import { describe, expect, it, vi } from 'vitest';
import {
  DisposableBag,
  VIRTUAL_DOCUMENT_UNAVAILABLE,
  VirtualDocumentRegistry,
} from './hostResources.js';

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

    expect(documents.get('karst-diff:/1/file.ts')).toBe('prepared content');
    documents.delete('karst-diff:/1/file.ts');
    expect(documents.get('karst-diff:/1/file.ts')).toBeUndefined();
  });

  it('isolates a committed owner from a colliding concurrent attempt', () => {
    const documents = new VirtualDocumentRegistry();
    const owner = documents.beginAttempt();
    owner.set('karst-diff:/1/file.ts', 'owner content');
    owner.commit();
    const collider = documents.beginAttempt();

    expect(() => collider.set('karst-diff:/1/file.ts', 'collider content')).toThrow(
      /already exists/i,
    );
    collider.rollback();

    expect(documents.get('karst-diff:/1/file.ts')).toBe('owner content');
  });

  it('rejects a duplicate insertion without overwriting its own first value', () => {
    const documents = new VirtualDocumentRegistry();
    const attempt = documents.beginAttempt();
    attempt.set('karst-diff:/1/file.ts', 'first content');

    expect(() => attempt.set('karst-diff:/1/file.ts', 'second content')).toThrow(
      /already exists/i,
    );
    expect(documents.get('karst-diff:/1/file.ts')).toBe('first content');

    attempt.rollback();
    expect(documents.get('karst-diff:/1/file.ts')).toBeUndefined();
  });

  it('refuses to serve a key it never registered instead of substituting empty text', () => {
    const documents = new VirtualDocumentRegistry();

    expect(documents.resolve('karst-diff:/9/restored-after-reload.ts')).toBe(
      VIRTUAL_DOCUMENT_UNAVAILABLE,
    );
    expect(VIRTUAL_DOCUMENT_UNAVAILABLE).not.toBe('');
    expect(VIRTUAL_DOCUMENT_UNAVAILABLE).toMatch(/no longer available/i);
  });

  it('refuses a key a rolled-back attempt or a document close removed', () => {
    const documents = new VirtualDocumentRegistry();
    const rolledBack = documents.beginAttempt();
    rolledBack.set('karst-diff:/1/left.ts', 'left content');
    rolledBack.rollback();
    const closed = documents.beginAttempt();
    closed.set('karst-diff:/2/right.ts', 'right content');
    closed.commit();
    documents.delete('karst-diff:/2/right.ts');

    expect(documents.resolve('karst-diff:/1/left.ts')).toBe(VIRTUAL_DOCUMENT_UNAVAILABLE);
    expect(documents.resolve('karst-diff:/2/right.ts')).toBe(VIRTUAL_DOCUMENT_UNAVAILABLE);
  });

  it('still serves a legitimately empty registered document as empty', () => {
    const documents = new VirtualDocumentRegistry();
    const attempt = documents.beginAttempt();
    // The left side of an added file is genuinely empty and must render as such.
    attempt.set('karst-diff:/1/added.ts', '');
    attempt.commit();

    expect(documents.resolve('karst-diff:/1/added.ts')).toBe('');
  });

  it('rejects every operation after an attempt commits or rolls back', () => {
    const documents = new VirtualDocumentRegistry();
    const committed = documents.beginAttempt();
    committed.commit();
    const rolledBack = documents.beginAttempt();
    rolledBack.rollback();

    for (const operation of [
      () => committed.set('committed', 'content'),
      () => committed.commit(),
      () => committed.rollback(),
      () => rolledBack.set('rolled-back', 'content'),
      () => rolledBack.commit(),
      () => rolledBack.rollback(),
    ]) {
      expect(operation).toThrow(/attempt is already (committed|rolled back)/i);
    }
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

  it('attempts every listener after one throws, then rethrows only the first error', () => {
    const firstError = new Error('first listener failed');
    const first = { dispose: vi.fn(() => { throw firstError; }) };
    const second = { dispose: vi.fn() };
    const third = { dispose: vi.fn() };
    const listeners = new DisposableBag();
    listeners.add(first);
    listeners.add(second);
    listeners.add(third);

    expect(() => listeners.dispose()).toThrow(firstError);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(third.dispose).toHaveBeenCalledOnce();

    expect(() => listeners.dispose()).not.toThrow();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    expect(third.dispose).toHaveBeenCalledOnce();
  });
});
