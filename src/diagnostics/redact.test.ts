import { describe, expect, it } from 'vitest'
import { redactText, sanitizeText } from './redact.js'
import { PROHIBITED_SENTINELS } from './fixtures/adversarial.js'

describe('diagnostic redaction', () => {
  it.each([
    'pAsSwOrD=super-secret-value',
    'Authorization: Bearer super-secret-value',
    'authorization=Bearer super-secret-value',
    'authorization=opaque-secret',
    '{"authorization":"opaque-secret"}',
    'authorization=opaque-\n secret',
    'Cookie: session=super-secret-value; safe=yes',
    'cookie=session=super-secret-value',
    'Authorization: Bearer super-\n secret-value',
    'authorization: Basic dXNlcjpzZWNyZXQ=',
    PROHIBITED_SENTINELS[0],
    PROHIBITED_SENTINELS[1],
    PROHIBITED_SENTINELS[2],
    PROHIBITED_SENTINELS[3],
    'https://user:password@example.com/a?token=super-secret-value&safe=yes',
    'token%3Dsuper-secret-value',
    '{"api_key":"super-secret-value"}',
    "export TOKEN='super-secret-value'",
    '-----BEGIN PRIVATE KEY-----\nprivate\nmaterial\n-----END PRIVATE KEY-----',
    'token=super-\n secret-value',
    'token=ab\n cd',
  ])('removes sensitive input: %s', input => {
    const result = redactText(input)
    expect(result.value).not.toContain('super-secret-value')
    expect(PROHIBITED_SENTINELS.every(value => !result.value.includes(value))).toBe(true)
    expect(result.counts.total).toBeGreaterThan(0)
  })

  it('normalizes controls, bounds output, and avoids ordinary prose false positives', () => {
    const prose = 'The test failed after the user clicked retry.'
    expect(redactText(prose).value).toBe(prose)
    expect(redactText(`ok\u0000bad`, { maxBytes: 100 }).value).toBe('')
    expect(sanitizeText('a'.repeat(100), { maxBytes: 12 }).omitted).toBe(true)
  })

  it('normalizes CRLF and omits NUL-containing input instead of silently changing it', () => {
    expect(sanitizeText('first\r\nsecond\rthird').value).toBe('first\nsecond\nthird')
    expect(sanitizeText('safe\u0000hidden')).toMatchObject({
      value: null,
      omitted: true,
      reason: 'nul',
    })
  })

  it('runs a final unsafe detection pass and omits anything still unsafe', () => {
    const result = sanitizeText('password=super-secret-value')
    expect(result.value).toBe('[REDACTED:assignment]')
    expect(result.omitted).toBe(false)
    expect(result.counts.total).toBe(1)
  })

  it('rejects oversized input before regex processing', () => {
    expect(sanitizeText('x'.repeat(100), { maxBytes: 8 })).toMatchObject({
      value: null,
      omitted: true,
      reason: 'input-too-large',
    })
  })

  it.each([
    'authorization=opaque-secret',
    '{"authorization":"opaque-secret"}',
    'authorization=opaque-\n secret',
  ])('removes the whole authorization assignment: %s', input => {
    const result = redactText(input)
    expect(result.value).not.toContain('opaque')
    expect(result.value).not.toContain('secret')
    expect(result.counts.total).toBeGreaterThan(0)
  })
})
