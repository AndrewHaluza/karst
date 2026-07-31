export interface DisposableLike {
  dispose(): void;
}

/** Owns subscriptions whose lifetime is one changes panel, not the extension. */
export class DisposableBag implements DisposableLike {
  private readonly items = new Set<DisposableLike>();
  private disposed = false;

  add(item: DisposableLike): void {
    if (this.disposed) {
      item.dispose();
      return;
    }
    this.items.add(item);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const owned = [...this.items];
    this.items.clear();
    let firstError: unknown;
    let failed = false;
    for (const item of owned) {
      try {
        item.dispose();
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) throw firstError;
  }
}

interface VirtualDocumentEntry {
  content: string;
  owner: symbol | null;
}

/**
 * Served in place of a virtual document the registry no longer holds. An empty
 * string is NOT a safe substitute: one side of a diff is legitimately empty for
 * an added or deleted file, so `''` would render as "the whole file was added"
 * with nothing marking it as fabricated. The registry is in-memory and rebuilt
 * per activation while VS Code restores open `karst-diff:` editors across a
 * window reload, so this is the text a restored — or rolled-back — editor gets.
 */
export const VIRTUAL_DOCUMENT_UNAVAILABLE = [
  'karst: this diff content is no longer available.',
  '',
  'The prepared text for this editor was released when the window reloaded, when',
  'the editor was closed, or when the diff failed to open. Close this editor and',
  'reopen the change from the ticket Changes panel.',
].join('\n');

/** Prepared virtual text keyed only by the host-created URI string. */
export class VirtualDocumentRegistry {
  private readonly documents = new Map<string, VirtualDocumentEntry>();

  get(key: string): string | undefined {
    return this.documents.get(key)?.content;
  }

  /**
   * The content provider's answer: the registered text, or a loud refusal when
   * this key is unknown. Distinguishes "never registered / evicted" from "holds
   * the empty string" — only the former is a refusal.
   */
  resolve(key: string): string {
    const entry = this.documents.get(key);
    return entry ? entry.content : VIRTUAL_DOCUMENT_UNAVAILABLE;
  }

  delete(key: string): void {
    this.documents.delete(key);
  }

  beginAttempt(): VirtualDocumentAttempt {
    return new VirtualDocumentAttempt(this.documents);
  }
}

export class VirtualDocumentAttempt {
  private readonly keys = new Set<string>();
  private readonly owner = Symbol('virtual-document-attempt');
  private state: 'active' | 'committed' | 'rolled back' = 'active';

  constructor(private readonly documents: Map<string, VirtualDocumentEntry>) {}

  set(key: string, content: string): void {
    this.assertActive();
    if (this.documents.has(key)) {
      throw new Error(`Virtual document already exists: ${key}`);
    }
    this.documents.set(key, { content, owner: this.owner });
    this.keys.add(key);
  }

  commit(): void {
    this.assertActive();
    for (const key of this.keys) {
      const entry = this.documents.get(key);
      if (entry?.owner === this.owner) entry.owner = null;
    }
    this.state = 'committed';
    this.keys.clear();
  }

  rollback(): void {
    this.assertActive();
    for (const key of this.keys) {
      if (this.documents.get(key)?.owner === this.owner) {
        this.documents.delete(key);
      }
    }
    this.state = 'rolled back';
    this.keys.clear();
  }

  private assertActive(): void {
    if (this.state !== 'active') {
      throw new Error(`Virtual document attempt is already ${this.state}`);
    }
  }
}
