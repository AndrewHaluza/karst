export interface KeyValueStore {
  get(key: string): Promise<number | undefined>;
  set(key: string, value: number): Promise<void>;
}
