import type { FakeCoreHit } from './fakeCore.js';

/** Process-wide record of which scripted rule answered each fake-core call (read by the UAT probe snapshot). */
const hits: FakeCoreHit[] = [];

export function recordFakeCoreHit(hit: FakeCoreHit): void {
  hits.push({ ...hit });
}

export function readFakeCoreHits(): FakeCoreHit[] {
  return hits.map((h) => ({ ...h }));
}

export function clearFakeCoreHits(): void {
  hits.length = 0;
}
