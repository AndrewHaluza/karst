import { DIAGNOSTIC_LIMITS } from './limits.js'

export interface RedactionResult {
  readonly value: string
  readonly counts: Readonly<Record<string, number>> & { readonly total: number }
  readonly truncated: boolean
}

export interface SanitizedText {
  readonly value: string | null
  readonly counts: Readonly<Record<string, number>> & { readonly total: number }
  readonly truncated: boolean
  readonly omitted: boolean
  readonly reason?: 'nul' | 'input-too-large' | 'unsafe-after-redaction'
}

const RULES: readonly [string, RegExp][] = [
  ['privateKey', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi],
  ['authorization', /\b(?:authorization\s*:\s*)?(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]+(?:\r?\n[ \t]+[A-Za-z0-9+/_=.-]+)*/gi],
  ['cookie', /\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi],
  ['cookie', /\b(?:set-cookie|cookie)\s*=\s*[^\r\n]+/gi],
  ['urlUserinfo', /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi],
  ['sensitiveQuery', /([?&](?:token|key|secret|password|credential|signature)=)[^&#\s]+/gi],
  ['jwt', /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g],
  ['githubToken', /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['openAiToken', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['awsAccessKey', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['foldedAssignment', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|token|secret|password|passwd|credential)\b["']?\s*(?:=|:)\s*[^\s,;}\]]+\s*\n\s*[^\s,;}\]]+/gi],
  ['assignment', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|authorization|token|secret|password|passwd|credential)\b["']?\s*(?:=|:)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]{4,}(?:\s*\n\s*[^\s,;}\]]+)?)/gi],
  ['encodedAssignment', /\b(?:token|secret|password|api(?:_|%5[fF])?key)%3[dD][A-Za-z0-9%+/_=.-]+/gi],
  ['longCredential', /\b(?=[A-Za-z0-9+/_=-]{64,}\b)(?=[A-Za-z0-9+/_=-]*[A-Z])(?=[A-Za-z0-9+/_=-]*[a-z])(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]+\b/g],
]

function boundedUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { value, truncated: false }
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end)) > maxBytes) end--
  return { value: value.slice(0, end), truncated: true }
}

function applyRules(input: string): {
  value: string
  counts: Record<string, number>
} {
  let value = input
  const counts: Record<string, number> = {}
  for (const [category, rule] of RULES) {
    value = value.replace(rule, () => {
      counts[category] = (counts[category] ?? 0) + 1
      return `[REDACTED:${category}]`
    })
  }
  return { value, counts }
}

export function sanitizeText(
  input: string,
  options: { readonly maxBytes?: number } = {},
): SanitizedText {
  if (input.includes('\u0000')) {
    return {
      value: null,
      counts: Object.freeze({ total: 0 }),
      truncated: false,
      omitted: true,
      reason: 'nul',
    }
  }
  const maxBytes = options.maxBytes ?? DIAGNOSTIC_LIMITS.maxFieldBytes
  if (Buffer.byteLength(input) > maxBytes) {
    return {
      value: null,
      counts: Object.freeze({ total: 0 }),
      truncated: false,
      omitted: true,
      reason: 'input-too-large',
    }
  }
  const normalized = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const first = applyRules(normalized)
  const second = applyRules(first.value)
  const total = Object.values(first.counts).reduce((sum, count) => sum + count, 0)
  if (Object.values(second.counts).some(count => count > 0)) {
    return {
      value: null,
      counts: Object.freeze({ ...first.counts, total }),
      truncated: false,
      omitted: true,
      reason: 'unsafe-after-redaction',
    }
  }
  const bounded = boundedUtf8(first.value, maxBytes)
  return {
    value: bounded.value,
    counts: Object.freeze({ ...first.counts, total }),
    truncated: bounded.truncated,
    omitted: false,
  }
}

export function redactText(
  input: string,
  options: { readonly maxBytes?: number } = {},
): RedactionResult {
  const result = sanitizeText(input, options)
  return {
    value: result.value ?? '',
    counts: result.counts,
    truncated: result.truncated,
  }
}

export function containsSensitiveValue(value: string): boolean {
  const result = sanitizeText(value, { maxBytes: Number.MAX_SAFE_INTEGER })
  return result.omitted || result.counts.total > 0
}

export function containsProhibitedSentinel(
  value: string,
  prohibitedValues: readonly string[],
): boolean {
  return prohibitedValues.some(sentinel => sentinel.length > 0 && value.includes(sentinel))
}
