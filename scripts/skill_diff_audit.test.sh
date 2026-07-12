#!/usr/bin/env bash
# Proven-firing acceptance for skill_diff_audit.py (K2). Self-contained: builds a
# throwaway skill tree + K1-log in /tmp and asserts the reconciliation. Run:
#   bash scripts/skill_diff_audit.test.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/skill_diff_audit.py"
T=/tmp/k2test; rm -rf "$T"; mkdir -p "$T/skills" "$T/store/self-audit"
export SKILL_AUDIT_DIRS="$T/skills" SKILL_AUDIT_LOG="$T/audit.log" \
       SKILL_AUDIT_BASELINE="$T/baseline.json" SKILL_AUDIT_REPORT="$T/report.log" \
       SKILL_AUDIT_DRYRUN=1
: > "$T/audit.log"
run() { python3 "$SCRIPT"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
logline() { printf '%s\t%s\tWrite\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$2" "$1" "$3" "$4" >> "$T/audit.log"; }
fail=0; ok() { echo "OK $1"; }; bad() { echo "XX $1"; fail=1; }

echo "content-a" > "$T/skills/a.md"; O=$(run)
[ -z "$O" ] && grep -q BASELINE-INIT "$T/report.log" && ok "A: baseline init, silent" || bad "A"

echo "legit" > "$T/skills/explained.md"; logline "$T/skills/explained.md" yoda create "$(sha "$T/skills/explained.md")"
echo "backdoor" > "$T/skills/evil.md"; O=$(run)
echo "$O" | grep -q "evil.md" && echo "$O" | grep -qv "explained.md" >/dev/null; \
  echo "$O" | grep -q evil.md && ! echo "$O" | grep -q explained.md && ok "B: escalate unexplained, silent on explained" || bad "B"

echo "tampered" > "$T/skills/explained.md"; rm "$T/skills/a.md"; O=$(run)
echo "$O" | grep -q "MODIFIED.*explained.md" && echo "$O" | grep -q "DELETED.*a.md" && ok "C: escalate out-of-band modify+delete" || bad "C"

O=$(run); [ -z "$O" ] && tail -1 "$T/report.log" | grep -q CLEAN && ok "D: no-change run silent" || bad "D"

echo ""; [ $fail -eq 0 ] && echo "ALL K2 ACCEPTANCE PASS" || echo "K2 ACCEPTANCE FAIL"; exit $fail
