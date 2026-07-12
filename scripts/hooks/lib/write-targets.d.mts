// Type declarations for the shared write-target extraction helper, so the
// vitest suites that import it type-check under the build's `tsc`.
export function extractAbsoluteTargets(
  seg: string,
  opts?: { writeIntent?: boolean },
): { targets: string[]; uncertain: boolean }
