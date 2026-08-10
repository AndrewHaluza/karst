export const DIAGNOSTIC_LIMITS = Object.freeze({
  maxLogEntries: 500,
  maxLogBufferBytes: 256 * 1024,
  /**
   * Debug-mode retention (the `debug` manifest flag): roomier than the normal
   * limits, because debug emits a line at every decision point. Sized so a
   * debug report — still capped by `maxReportLogEntries`/`maxReportLogBytes`
   * at collection time — keeps the interesting entries instead of evicting
   * them for the noise. Applied by `makeBoundedLogBuffer.setDebugRetention`.
   */
  debugLogEntries: 2000,
  debugLogBufferBytes: 1024 * 1024,
  maxReportLogEntries: 200,
  maxReportLogBytes: 128 * 1024,
  maxRowsPerSection: 500,
  /** Verbatim bridge failures kept; the outcome totals still cover every line. */
  maxHookFailures: 50,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxFieldBytes: 32 * 1024,
  maxSectionBytes: 1024 * 1024,
  maxTotalBytes: 1024 * 1024,
})

export type DiagnosticLimits = typeof DIAGNOSTIC_LIMITS
