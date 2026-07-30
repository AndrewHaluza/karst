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

/** Prepared virtual text keyed only by the host-created URI string. */
export class VirtualDocumentRegistry {
  private readonly documents = new Map<string, VirtualDocumentEntry>();

  get(key: string): string | undefined {
    return this.documents.get(key)?.content;
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
