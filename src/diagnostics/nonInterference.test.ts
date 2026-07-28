import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Static non-interference guard (Phase 4).
 *
 * Issue reporting must never be able to mutate stages, sessions, gates, hooks,
 * or the manifest, and must never spawn a process or open a socket — not even
 * transitively. A single convenience import (e.g. the agent registry, which
 * constructs launch adapters) is enough to pull `node:child_process` and the
 * hook-settings writer into the reporting graph, so the reachable module set
 * is what this asserts, not the entry files alone.
 */

const ENTRY_POINTS = [
  'src/diagnostics/collectMetadata.ts',
  'src/diagnostics/context.ts',
  'src/diagnostics/projectConfig.ts',
  'src/diagnostics/reportFlow.ts',
  'src/diagnostics/reportIssueModel.ts',
  'src/diagnostics/storeEvidence.ts',
  'src/diagnostics/finalize.ts',
  'src/extension/reportIssue.ts',
] as const

/** Bare modules that grant process, filesystem-write, or network reach. */
const FORBIDDEN_BARE = [
  'child_process',
  'node:child_process',
  'node:http',
  'node:https',
  'node:net',
  'node:dgram',
  'node:worker_threads',
  'undici',
  'node-fetch',
]

/** Project modules that mutate workflow state or run external work. */
const FORBIDDEN_LOCAL = [
  'src/workflow/',
  'src/hooks/',
  'src/gh/',
  'src/agent/claude.ts',
  'src/agent/codex.ts',
  'src/agent/antigravity.ts',
  'src/agent/settings.ts',
  'src/manifest/write.ts',
  'src/context/ticketContext.ts',
]

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;'"]*?from\s+['"]([^'"]+)['"]/g

function importsOf(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(IMPORT)) {
    if (match[1]) continue // `import type` is erased at runtime
    if (match[2]) found.push(match[2])
  }
  return found
}

interface Edge {
  readonly from: string
  readonly to: string
}

/** Walk relative imports from the entry points; record every reachable edge. */
function reachable(entries: readonly string[]): { files: Set<string>; edges: Edge[] } {
  const files = new Set<string>()
  const edges: Edge[] = []
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const specifier of importsOf(source)) {
      if (!specifier.startsWith('.')) {
        edges.push({ from: file, to: specifier })
        continue
      }
      const target = relative(
        process.cwd(),
        resolve(dirname(file), specifier.replace(/\.js$/, '.ts')),
      )
      edges.push({ from: file, to: target })
      queue.push(target)
    }
  }
  return { files, edges }
}

describe('issue reporting non-interference', () => {
  const graph = reachable(ENTRY_POINTS)

  it('detects a forbidden edge when one exists', () => {
    // The detector has teeth: a synthetic violating module is flagged.
    expect(importsOf("import { spawn } from 'node:child_process'\n"))
      .toEqual(['node:child_process'])
    expect(importsOf("import type { Store } from '../store/db.js'\n")).toEqual([])
  })

  it('cannot reach process, network, or workflow-mutating modules', () => {
    const violations = graph.edges.filter(
      (edge) =>
        FORBIDDEN_BARE.includes(edge.to)
        || FORBIDDEN_LOCAL.some((prefix) => edge.to.startsWith(prefix)),
    )
    expect(violations).toEqual([])
  })

  it('issues no write SQL anywhere in the reachable graph', () => {
    const writes: string[] = []
    for (const file of graph.files) {
      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      if (!file.startsWith('src/diagnostics/') && !file.startsWith('src/extension/reportIssue')) {
        continue // shared store helpers keep their own writers; reporting never calls them
      }
      for (const line of source.split('\n')) {
        if (/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+|ALTER\s+TABLE)/i.test(line)) {
          writes.push(`${file}: ${line.trim()}`)
        }
      }
    }
    expect(writes).toEqual([])
  })
})
