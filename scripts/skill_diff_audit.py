#!/usr/bin/env python3
"""K2 -- skill-directory diff-audit (injection-defense package, component 4).

Deterministic, 0-token (schedule-runner type=command). Second layer over K1's
event log (store/skill-audit.log): a daily sha256 snapshot of the skill dirs is
diffed against the previous baseline, and every change is reconciled against the
K1 log. A change the log does NOT explain -- an OUT-OF-BAND edit (direct fs, or
any write that bypassed skill-write-guard) -- is escalated to EliteAI. All
changes explained -> silent (0 tokens, one CLEAN audit line).

Reconciliation (path+hash, tokenization-independent):
  * added / modified file  -> EXPLAINED iff the log has an entry with the same
    resolved path AND the same NEW sha256 (K1 logs the content hash at write
    time; an out-of-band edit's hash is never in the log).
  * deleted file           -> EXPLAINED iff the log has a path + action=delete.

First run establishes the baseline silently (pre-existing files predate K1 and
must not all alert). Env overrides (never agent-controllable -- runs in the
schedule-runner process) let the isolated test point every path at a throwaway
tree: SKILL_AUDIT_DIRS (':'-joined), SKILL_AUDIT_LOG, SKILL_AUDIT_BASELINE,
SKILL_AUDIT_REPORT, SKILL_AUDIT_ROOT, SKILL_AUDIT_HOME, SKILL_AUDIT_DRYRUN=1
(print the escalation instead of POSTing).
"""
import os
import sys
import json
import glob
import hashlib
import urllib.request
from datetime import datetime, timezone

HOME = os.environ.get("SKILL_AUDIT_HOME", os.path.expanduser("~"))
ROOT = os.environ.get("SKILL_AUDIT_ROOT", "/home/kapucnis/marveen")
AUDIT_LOG = os.environ.get("SKILL_AUDIT_LOG", ROOT + "/store/skill-audit.log")
BASELINE = os.environ.get("SKILL_AUDIT_BASELINE", ROOT + "/store/self-audit/skill-baseline.json")
REPORT = os.environ.get("SKILL_AUDIT_REPORT", ROOT + "/store/self-audit/skill-diff-audit.log")
TOKEN_FILE = ROOT + "/store/.dashboard-token"
DASH = os.environ.get("SKILL_AUDIT_DASH", "http://localhost:3420")
DRYRUN = os.environ.get("SKILL_AUDIT_DRYRUN") == "1"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def skill_dirs():
    override = os.environ.get("SKILL_AUDIT_DIRS")
    if override:
        return [d for d in override.split(":") if d]
    dirs = [HOME + "/.claude/skills"]
    dirs += sorted(glob.glob(ROOT + "/agents/*/.claude/skills"))
    return dirs


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def snapshot():
    snap = {}
    for d in skill_dirs():
        for p in glob.glob(d + "/**", recursive=True):
            if os.path.isfile(p):
                try:
                    snap[os.path.realpath(p)] = sha256_file(p)
                except OSError:
                    pass
    return snap


def load_baseline():
    try:
        with open(BASELINE) as f:
            data = json.load(f)
        return data.get("hashes", {}) if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def save_baseline(snap):
    os.makedirs(os.path.dirname(BASELINE), exist_ok=True)
    with open(BASELINE, "w") as f:
        json.dump({"ts": now_iso(), "hashes": snap}, f, indent=0, sort_keys=True)


def parse_log():
    """Return {(realpath, sha256): True} for add/modify and {realpath} for deletes."""
    hashed, deleted = set(), set()
    try:
        with open(AUDIT_LOG) as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 6:
                    continue
                _ts, _agent, _tool, path, action, sha = parts[:6]
                rp = os.path.realpath(path)
                if action == "delete":
                    deleted.add(rp)
                else:
                    hashed.add((rp, sha))
    except OSError:
        pass
    return hashed, deleted


def report_line(kind, detail):
    try:
        os.makedirs(os.path.dirname(REPORT), exist_ok=True)
        with open(REPORT, "a") as f:
            f.write("%s\t%s\t%s\n" % (now_iso(), kind, detail))
    except OSError:
        pass


def escalate(unexplained):
    lines = ["%s %s (%s)" % (kind, path, sha[:12] if sha else "-") for kind, path, sha in unexplained]
    summary = ("K2 skill-diff-audit: %d MAGYARAZATLAN skill-mappa valtozas "
               "(a K1 esemeny-log nem fedi -- out-of-band iras?):\n- %s" %
               (len(unexplained), "\n- ".join(lines)))
    report_line("ESCALATE", summary.replace("\n", " | "))
    if DRYRUN:
        print(summary)
        return
    try:
        token = open(TOKEN_FILE).read().strip()
        # Self-directed: the audit runs as EliteAI's own scheduled task (agent:eliteai
        # in the task-config), so it escalates into EliteAI's session, not nano's.
        body = json.dumps({"from": "eliteai", "to": "eliteai", "content": summary}).encode()
        req = urllib.request.Request(DASH + "/api/messages", data=body,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer " + token})
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:  # never let escalation failure crash the audit
        report_line("ESCALATE-FAIL", str(e))


def main():
    cur = snapshot()
    baseline = load_baseline()
    if baseline is None:
        save_baseline(cur)
        report_line("BASELINE-INIT", "files=%d" % len(cur))
        return
    hashed, deleted = parse_log()
    unexplained = []
    for path, sha in cur.items():
        if path not in baseline:
            if (path, sha) not in hashed:
                unexplained.append(("ADDED", path, sha))
        elif baseline[path] != sha:
            if (path, sha) not in hashed:
                unexplained.append(("MODIFIED", path, sha))
    for path in baseline:
        if path not in cur:
            if path not in deleted:
                unexplained.append(("DELETED", path, ""))
    if unexplained:
        escalate(unexplained)
    else:
        report_line("CLEAN", "files=%d" % len(cur))
    save_baseline(cur)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # fail-safe: log, never crash the schedule-runner slot
        report_line("ERROR", str(e))
        sys.exit(0)
