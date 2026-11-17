export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  set(key: string, value: V, ttlSeconds: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds });
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt < Date.now()) return undefined;
    return entry.value;
  }
}
