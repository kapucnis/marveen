// Type declarations for the skill-write-guard hook's exported pure logic, so
// the vitest suite (src/__tests__/skill-write-guard.test.ts) type-checks under
// the build's `tsc`. The hook itself is plain Node .mjs (no build step).

export type TargetKind =
  | 'global-skill'
  | 'scheduled-task'
  | 'local-skill'
  | 'guard-token'
  | 'guard-log'
  | 'guard-consumed'

export interface Roots {
  home?: string
  root?: string
}

export interface Grant {
  nonce?: string
  expiresAt?: number | string
  pathGlob: string
}

export interface SkillTargetHit {
  real: string
  kind: TargetKind
  action: 'create' | 'modify' | 'delete'
}

export interface CollectedTarget {
  real: string
  kind: TargetKind
  action: 'create' | 'modify' | 'delete'
  tool: string
  hash: string
}

export interface Decision {
  deny: boolean
  why?: string
  audit?: boolean
  consumeNonce?: string
}

export type Consumed = Set<string> | string[]

export function splitSegments(command: string): string[]
export function stripHeredocBodies(command: string): string
export function stripDataPayloads(seg: string): string
export function classifyTarget(realPath: string, roots?: Roots): TargetKind | null
export function globToRegExp(glob: string): RegExp
export function parseApproval(raw: string): Grant[]
export function parseConsumed(raw: string): Set<string>
export function matchingGrant(grants: Grant[], realPath: string, now: number, consumed?: Consumed): Grant | null
export function approvalCovers(grants: Grant[], realPath: string, now: number, consumed?: Consumed): boolean
export function evaluate(args: {
  kind: TargetKind | null
  realPath: string
  grants: Grant[]
  consumed?: Consumed
  now: number
}): Decision
export function bashSkillTargets(command: string, roots?: Roots): SkillTargetHit[]
export function collectTargets(payload: unknown): CollectedTarget[]
