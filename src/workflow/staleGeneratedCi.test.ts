import { describe, expect, it } from 'vitest';
import { classifyStaleGeneratedLog, STALE_PATTERN_PREFIX } from './staleGeneratedCi.js';

const MAP = 'docs/arch/system-map.md is stale: run npm run -s docs:graph';
const LIST = ['npm run -s docs:graph', 'npm run -s docs:index'];
const EXIT = '##[error]Process completed with exit code 1.';

describe('classifyStaleGeneratedLog', () => {
  it('matches one stale line whose command is in ship.regenerate', () => {
    expect(classifyStaleGeneratedLog(`${MAP}\n${EXIT}\n`, LIST)).toEqual(['npm run -s docs:graph']);
  });

  it('returns each command once when several stale lines name it', () => {
    const log = `${MAP}\ndocs/other.md is stale: run npm run -s docs:index\n${MAP}\n${EXIT}`;
    expect(classifyStaleGeneratedLog(log, LIST)).toEqual(['npm run -s docs:graph', 'npm run -s docs:index']);
  });

  it('does not match a stale line for a command that is not in ship.regenerate', () => {
    expect(classifyStaleGeneratedLog('docs/arch/schema.md is stale: run npm run -s docs:schema\n' + EXIT, LIST)).toBeNull();
  });

  it('does not match when one stale line is in the list and another is not', () => {
    expect(classifyStaleGeneratedLog(`${MAP}\nx.md is stale: run npm run -s docs:schema`, LIST)).toBeNull();
  });

  it('does not match a stale line plus another step-level error', () => {
    expect(classifyStaleGeneratedLog(`${MAP}\n##[error]Something else failed\n${EXIT}`, LIST)).toBeNull();
    expect(classifyStaleGeneratedLog(`${MAP}\nnpm error code ELIFECYCLE\n${EXIT}`, LIST)).toBeNull();
  });

  it('does not match a stale line plus a test failure', () => {
    expect(classifyStaleGeneratedLog(`${MAP}\n FAIL  src/a.test.ts > a\nAssertionError: expected 1 to be 2\n${EXIT}`, LIST)).toBeNull();
    expect(classifyStaleGeneratedLog(`${MAP}\n Tests  2 failed | 10 passed\n${EXIT}`, LIST)).toBeNull();
  });

  it('does not match a log with no stale line', () => {
    expect(classifyStaleGeneratedLog(`${EXIT}\n`, LIST)).toBeNull();
    expect(classifyStaleGeneratedLog('', LIST)).toBeNull();
  });

  it('does not match when ship.regenerate is empty', () => {
    expect(classifyStaleGeneratedLog(MAP, [])).toBeNull();
  });

  it('strips ANSI codes, the runner timestamp and the gh job and step prefix', () => {
    const ansi = `\u001b[31m${MAP}\u001b[0m`;
    expect(classifyStaleGeneratedLog(ansi, LIST)).toEqual(['npm run -s docs:graph']);
    expect(classifyStaleGeneratedLog(`2026-11-08T10:00:00.1234567Z ${MAP}`, LIST)).toEqual(['npm run -s docs:graph']);
    expect(classifyStaleGeneratedLog(`Docs gate\tRun docs:graph check\t2026-11-08T10:00:00.1234567Z ${MAP}\nDocs gate\tRun docs:graph check\t2026-11-08T10:00:01Z ${EXIT}`, LIST)).toEqual(['npm run -s docs:graph']);
    expect(classifyStaleGeneratedLog(`2026-11-08T10:00:00Z ##[error]${MAP}\n${EXIT}`, LIST)).toEqual(['npm run -s docs:graph']);
  });

  it('reads only the tail of a long log', () => {
    const log = `${'x'.repeat(300_000)}\n${MAP}\n${EXIT}`;
    expect(classifyStaleGeneratedLog(log, LIST)).toEqual(['npm run -s docs:graph']);
  });

  it('does not treat a command with extra shell text as a list entry', () => {
    expect(classifyStaleGeneratedLog('a.md is stale: run npm run -s docs:graph; rm -rf /', LIST)).toBeNull();
  });

  it('exposes the marker prefix', () => {
    expect(STALE_PATTERN_PREFIX).toBe('stale-generated:');
  });
});
