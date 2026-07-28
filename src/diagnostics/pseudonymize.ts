import { createHmac, randomBytes } from 'node:crypto'

export type AliasKind =
  | 'project'
  | 'ticket'
  | 'session'
  | 'path'
  | 'branch'
  | 'baseRef'

export type Pseudonymizer = Readonly<Record<AliasKind, (value: string) => string>>

export function createPseudonymizer(key: Uint8Array = randomBytes(32)): Pseudonymizer {
  if (key.byteLength !== 32) throw new Error('A pseudonym key must be 32 bytes')
  const alias = (kind: AliasKind, value: string): string => {
    const digest = createHmac('sha256', key)
      .update(kind)
      .update('\0')
      .update(value)
      .digest('hex')
      .slice(0, 12)
    return `${kind}_${digest}`
  }
  return Object.freeze({
    project: value => alias('project', value),
    ticket: value => alias('ticket', value),
    session: value => alias('session', value),
    path: value => alias('path', value),
    branch: value => alias('branch', value),
    baseRef: value => alias('baseRef', value),
  })
}
