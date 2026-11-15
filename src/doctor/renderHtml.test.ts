import { describe, expect, it } from 'vitest';
import { cspMetaTag } from '../model/csp.js';
import { renderDoctorHtml } from './renderHtml.js';
import type { DoctorReport } from './types.js';

const report: DoctorReport = { checks: [], applied: [], summary: { ok: 0, warn: 0, fail: 0 } } as unknown as DoctorReport;

describe('renderDoctorHtml CSP', () => {
  it('carries the shared policy meta tag and the nonce on its script', () => {
    const html = renderDoctorHtml(report, 'abc123');
    expect(html).toContain(cspMetaTag('abc123'));
    expect(html).toContain("script-src 'nonce-abc123'");
    expect(html).toContain('<script nonce="abc123">');
  });
});
