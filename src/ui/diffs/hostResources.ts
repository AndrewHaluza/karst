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
    for (const item of this.items) item.dispose();
    this.items.clear();
  }
}

/** Prepared virtual text keyed only by the host-created URI string. */
export class VirtualDocumentRegistry {
  private readonly documents = new Map<string, string>();

  get(key: string): string | undefined {
    return this.documents.get(key);
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
  private committed = false;

  constructor(private readonly documents: Map<string, string>) {}

  set(key: string, content: string): void {
    this.documents.set(key, content);
    this.keys.add(key);
  }

  commit(): void {
    this.committed = true;
    this.keys.clear();
  }

  rollback(): void {
    if (this.committed) return;
    for (const key of this.keys) this.documents.delete(key);
    this.keys.clear();
  }
}
