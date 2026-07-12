// Type declarations for the yoda-write-guard hook's exported pure logic, so the
// vitest suite (src/__tests__/yoda-write-guard.test.ts) type-checks under the
// build's `tsc`. The hook itself is plain Node .mjs (no build step).

export interface Grant {
  nonce?: string
  expiresAt?: number | string
  pathGlob?: string
  approvedBy?: string
}

export interface BashAttempt {
  real: string | null
  guardOwn: boolean
}

export interface WriteAttempt {
  tool?: string
  real: string | null
  pathOrCmd?: string
  guardOwn: boolean
}

export interface Decision {
  deny: boolean
  why?: string
  reason?: string
  consumeNonce?: string
}

export type Consumed = Set<string> | string[]

export function splitSegments(command: string): string[]
export function stripHeredocBodies(command: string): string
export function stripDataPayloads(seg: string): string
export function globToRegExp(glob: string): RegExp
export function parseApproval(raw: string): Grant[]
export function parseConsumed(raw: string): Set<string>
export function matchingGrant(
  grants: Grant[],
  realPath: string | null,
  now: number,
  consumed?: Consumed,
): Grant | null
export function bashWriteAttempts(command: string): BashAttempt[]
export function collectWriteAttempts(payload: unknown): WriteAttempt[]
export function decide(args: {
  attempt: WriteAttempt
  grants: Grant[]
  consumed?: Consumed
  now: number
}): Decision
