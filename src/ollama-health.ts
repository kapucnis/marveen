import { OLLAMA_URL } from './config.js'
import { logger } from './logger.js'

// C4: startup-only, proactive Ollama reachability check -- distinct from
// generateEmbedding()'s existing per-call fallback (db.ts), which logs at
// debug level and silently returns null so a normal host install (where
// Ollama not running is common and unremarkable) doesn't spam INFO logs. In
// a container deployment OLLAMA_URL is a deliberate dependency
// (host.docker.internal via extra_hosts: host-gateway, or the optional
// `ollama` compose profile), so its absence should be LOUD at boot and
// visible in the dashboard -- not just a quiet per-query fallback discovered
// one search at a time. Search itself keeps working throughout: it already
// falls back to keyword mode (withEmbedding=0) whenever an embedding is
// unavailable, checked or not.
let ollamaAvailable = true
let lastCheckedAt: number | null = null

export function isOllamaAvailable(): boolean {
  return ollamaAvailable
}

export function ollamaHealthState(): { available: boolean; lastCheckedAt: number | null; url: string } {
  return { available: ollamaAvailable, lastCheckedAt, url: OLLAMA_URL }
}

export async function checkOllamaHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) })
    ollamaAvailable = resp.ok
  } catch {
    ollamaAvailable = false
  }
  lastCheckedAt = Date.now()
  if (!ollamaAvailable) {
    logger.warn(
      { ollamaUrl: OLLAMA_URL },
      'C4: Ollama unreachable at startup -- semantic/embedding memory search is ' +
      'DEGRADED, falling back to keyword search. If this is a container: check ' +
      'OLLAMA_URL (host.docker.internal on Linux needs extra_hosts: host-gateway ' +
      'in docker-compose.yml) and that Ollama is running on the host, or enable ' +
      'the optional `ollama` compose profile.'
    )
  } else {
    logger.info({ ollamaUrl: OLLAMA_URL }, 'Ollama reachable at startup')
  }
  return ollamaAvailable
}
