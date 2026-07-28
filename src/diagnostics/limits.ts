export const DIAGNOSTIC_LIMITS = Object.freeze({
  maxLogEntries: 500,
  maxLogBufferBytes: 256 * 1024,
  maxReportLogEntries: 200,
  maxReportLogBytes: 128 * 1024,
  maxRowsPerSection: 500,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxFieldBytes: 32 * 1024,
  maxSectionBytes: 1024 * 1024,
  maxTotalBytes: 1024 * 1024,
})

export type DiagnosticLimits = typeof DIAGNOSTIC_LIMITS
