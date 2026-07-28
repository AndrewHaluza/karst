import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// `dist/` is shipped WHOLESALE inside the .vsix. Test-only fixtures therefore
// must never be emitted: `diagnostics/fixtures/adversarial.ts` holds
// realistic-looking secrets on purpose (the redaction suite proves they are
// stripped), and vsce's secret scanner refuses to package a file containing a
// literal `ghp_…` token — so an emitted fixture breaks `install-local.sh`
// outright, not just bloats the package.
const repoRoot = join(import.meta.dirname, '..', '..')

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(entry => {
    const abs = join(dir, entry)
    if (entry === 'node_modules' || entry === 'dist') return []
    return statSync(abs).isDirectory() ? walk(abs) : [abs]
  })

/** Minimal tsconfig-glob matcher: `**` any depth, `*` one segment. */
const excludes = (pattern: string, relPath: string): boolean => {
  const rx = pattern
    .split('/')
    .map(seg =>
      seg === '**' ? '.*' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
    )
    .join('/')
  return new RegExp(`^${rx}(/|$)`).test(relPath)
}

describe('test-only fixtures are excluded from the shipped build', () => {
  const config = JSON.parse(
    readFileSync(join(repoRoot, 'tsconfig.build.json'), 'utf8'),
  ) as { exclude?: string[] }
  const patterns = config.exclude ?? []

  const fixtureSources = walk(join(repoRoot, 'src'))
    .map(abs => relative(repoRoot, abs).split(sep).join('/'))
    .filter(rel => /(^|\/)fixtures(\.ts$|\/)/.test(rel))

  it('finds the fixture modules it is meant to guard', () => {
    expect(fixtureSources).toContain('src/diagnostics/fixtures/adversarial.ts')
    expect(fixtureSources).toContain('src/manifest/fixtures.ts')
  })

  it.each(fixtureSources)('%s is matched by a tsconfig.build.json exclude', rel => {
    expect(patterns.some(pattern => excludes(pattern, rel))).toBe(true)
  })
})
