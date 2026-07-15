import { describe, it, expect } from 'vitest';
import { renderHealthUrl } from './healthUrl.js';

describe('renderHealthUrl', () => {
  it('substitutes {host} and {port} — the documented template convention', () => {
    expect(renderHealthUrl('http://{host}:{port}/health', '127.0.0.1', 4300)).toBe(
      'http://127.0.0.1:4300/health',
    );
  });

  it('substitutes {port} even in a bare-root template (matches karst.yml health: http://{host}:{port}/)', () => {
    expect(renderHealthUrl('http://{host}:{port}/', '127.0.0.1', 3030)).toBe(
      'http://127.0.0.1:3030/',
    );
  });

  it('also accepts the {http} alias for the http port so legacy templates keep working', () => {
    expect(renderHealthUrl('http://{host}:{http}/health', 'localhost', 8080)).toBe(
      'http://localhost:8080/health',
    );
  });

  it('leaves a template with no placeholders untouched', () => {
    expect(renderHealthUrl('http://example.test/ok', '127.0.0.1', 5000)).toBe(
      'http://example.test/ok',
    );
  });
});
