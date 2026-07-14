#!/usr/bin/env python3
"""Deterministic 0-token kanban audit (heartbeat->command, 2026-07-10).

Runs 4x/day (0 8,12,16,20). Two jobs, both gated by store/autonomy-config.json
levels (kanban_archive_done / kanban_stuck_nudge -- see SKILL.md for the level
semantics):

1. Archive 7+ day old 'done' cards (archived_at is a soft flag, never a delete
   -- always reversible with a plain UPDATE).
2. Detect 'in_progress' cards that have not moved since the PREVIOUS audit
   (updated_at < last_audit_at, not an absolute time window) and ping the
   assignee via inter-agent message; escalate to eliteai's own Telegram after
   ESCALATE_AFTER consecutive stuck audits for the same card+assignee.

Replaces the old type=heartbeat SKILL.md procedure, which called the `sqlite3`
and `jq` CLIs -- neither is installed on this host, so every run either
improvised (extra model tokens) or silently dropped a step. This script uses
only stdlib (sqlite3, json) plus scripts/notify_utils.py for Telegram/ledger.

State: store/kanban-audit-state.json
  last_audit_at   : unix ts of the previous run (null on first run: sets the
                     watermark but never pings -- avoids a false "stuck" read
                     against pre-existing cards)
  stuck_pings      : {card_id: consecutive-stuck-audit count}
  stuck_assignee   : {card_id: assignee at last count} -- an assignee change
                     resets the counter, since a reassignment is a fresh start
Cards that stop being stuck (moved, archived, or vanished) have their entry
dropped from both maps on the same run, per GPT-crosscheck advice.

Modes
  (default)   normal run: audit, act per autonomy level, advance state
  --dry-run   print what would happen, write/send nothing
"""
import fcntl
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notify_utils as notify  # noqa: E402

MARVEEN_ROOT = '/home/kapucnis/marveen'
DB_PATH = os.path.join(MARVEEN_ROOT, 'store', 'claudeclaw.db')
STATE_PATH = os.path.join(MARVEEN_ROOT, 'store', 'kanban-audit-state.json')
AUTONOMY_PATH = os.path.join(MARVEEN_ROOT, 'store', 'autonomy-config.json')
LOG_DIR = os.path.join(MARVEEN_ROOT, 'store', 'kanban-audit')
LOG_PATH = os.path.join(LOG_DIR, 'audit.log')
LOCK_PATH = os.path.join(LOG_DIR, 'kanban-audit.lock')

ESCALATE_AFTER = 2  # consecutive stuck audits before escalating to Laci
AGENT_ID = 'eliteai'


def autonomy_level(key, default=3):
    cfg = notify.load_json(AUTONOMY_PATH, {})
    for cat in cfg.get('categories', []):
        if cat.get('key') == key:
            return cat.get('level', default)
    return default


def acquire_lock():
    os.makedirs(LOG_DIR, exist_ok=True)
    fh = open(LOCK_PATH, 'w')
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fh
    except BlockingIOError:
        fh.close()
        return None


def run(dry):
    lock = None
    if not dry:
        lock = acquire_lock()
        if lock is None:
            print('another instance holds the lock -- skipping this tick')
            return

    state = notify.load_json(STATE_PATH, {})
    last_audit_at = state.get('last_audit_at')
    stuck_pings = dict(state.get('stuck_pings', {}))
    stuck_assignee = dict(state.get('stuck_assignee', {}))
    first_run = last_audit_at is None

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    audit_lines = []
    tg_lines = []  # one consolidated Telegram message at the end, if non-empty

    # --- 1. Archive 7+ day old done cards ------------------------------
    arch_level = autonomy_level('kanban_archive_done')
    c.execute(
        "SELECT id, title FROM kanban_cards WHERE status='done' "
        "AND archived_at IS NULL AND updated_at < strftime('%s','now','-7 days')"
    )
    stale_done = c.fetchall()
    if stale_done:
        if arch_level >= 3:
            audit_lines.append(f'ARCHIVE ({len(stale_done)}): ' +
                                ', '.join(f'{r["id"]}={r["title"][:40]}' for r in stale_done))
            if not dry:
                c.execute(
                    "UPDATE kanban_cards SET archived_at=unixepoch() WHERE status='done' "
                    "AND archived_at IS NULL AND updated_at < strftime('%s','now','-7 days')"
                )
                conn.commit()
        elif arch_level == 2:
            tg_lines.append(
                f'{len(stale_done)} db 7+ napos "done" kártya archiválásra vár, mehet? '
                f'(kanban-audit, level 2 -- jóváhagyás után emeld level 3-ra vagy archiváld kézzel)'
            )
        else:  # level 1
            tg_lines.append(f'{len(stale_done)} db 7+ napos "done" kártya van (archiválás kikapcsolva, level 1).')

    # --- 2. Stuck in_progress detection ---------------------------------
    stuck_level = autonomy_level('kanban_stuck_nudge')
    pings, escalations, level1_list = [], [], []
    current_stuck_ids = set()

    if not first_run:
        c.execute(
            "SELECT id, title, assignee, ROUND((strftime('%s','now')-updated_at)/3600.0,1) as hours_stale "
            "FROM kanban_cards WHERE status='in_progress' AND archived_at IS NULL "
            "AND updated_at < ? ORDER BY hours_stale DESC",
            (last_audit_at,),
        )
        for r in c.fetchall():
            cid, title, hours = r['id'], r['title'], r['hours_stale']
            assignee = (r['assignee'] or '').strip().lower()
            current_stuck_ids.add(cid)
            if stuck_assignee.get(cid) != assignee:
                stuck_pings[cid] = 0  # reassigned -> fresh start
            stuck_pings[cid] = stuck_pings.get(cid, 0) + 1
            stuck_assignee[cid] = assignee
            count = stuck_pings[cid]

            if stuck_level == 1:
                level1_list.append((cid, title, assignee, hours))
                continue
            if stuck_level == 2:
                pings.append((cid, title, assignee, hours, count))  # proposal only, no auto-ping
                continue
            # level 3: auto-ping, or escalate after ESCALATE_AFTER rounds
            if not assignee or assignee == AGENT_ID:
                continue  # nothing to ping; falls under "delegálatlan" below
            if count > ESCALATE_AFTER:
                escalations.append((cid, title, assignee, hours, count))
            else:
                pings.append((cid, title, assignee, hours, count))

    # Clear counters for cards that are no longer stuck (moved/archived/gone).
    for cid in list(stuck_pings.keys()):
        if cid not in current_stuck_ids:
            stuck_pings.pop(cid, None)
            stuck_assignee.pop(cid, None)

    if stuck_level == 3:
        for cid, title, assignee, hours, count in pings:
            msg = (f'Kanban-audit: a {cid} ({title}) {hours}h-ja in_progress mozgás nélkül '
                   f'(előző audit óta). Frissítsd a státuszt (done/waiting) vagy adj kommentet, hogy mit blokkol.')
            if dry:
                audit_lines.append(f'WOULD-PING {cid} -> {assignee} ({hours}h, kör {count})')
                continue
            try:
                notify.send_inter_agent(AGENT_ID, assignee, msg)
                audit_lines.append(f'PING {cid} -> {assignee} ({hours}h, kör {count})')
            except Exception as e:
                audit_lines.append(f'PING-FAIL {cid} -> {assignee}: {e}')

    if escalations:
        lines = [f'- {cid} ({title}), assignee {assignee}, {hours}h stale, {count}. kör'
                 for cid, title, assignee, hours, count in escalations]
        tg_lines.append(
            f'{len(escalations)} beakadt kártya {ESCALATE_AFTER}+ auditkör óta nem mozdult, '
            f'az assignee-ping nem hozott eredményt:\n' + '\n'.join(lines)
        )
        audit_lines.append(f'ESCALATE ({len(escalations)}): ' + ', '.join(c for c, *_ in escalations))

    if stuck_level == 2 and pings:
        lines = [f'- {cid} ({title}), assignee {assignee}, {hours}h stale' for cid, title, assignee, hours, _ in pings]
        tg_lines.append(f'{len(pings)} beakadt kártya, pingeljem az assignee-ket? (level 2)\n' + '\n'.join(lines))

    if stuck_level == 1 and level1_list:
        tg_lines.append(f'{len(level1_list)} beakadt kártya (csak jelzés, level 1, nincs ping).')

    # --- 3. Delegálatlan kártyák (3+) ------------------------------------
    c.execute(
        "SELECT count(*) as n FROM kanban_cards WHERE archived_at IS NULL "
        "AND status IN ('planned','in_progress','waiting') AND (assignee IS NULL OR assignee = '')"
    )
    unassigned = c.fetchone()['n']
    if unassigned >= 3:
        tg_lines.append(f'{unassigned} delegálatlan (assignee nélküli) nyitott kártya van a táblán.')
        audit_lines.append(f'UNASSIGNED: {unassigned}')

    # --- 4. Waiting > 48h blokkolók --------------------------------------
    c.execute(
        "SELECT id, title, ROUND((strftime('%s','now')-updated_at)/3600.0,1) as hours "
        "FROM kanban_cards WHERE status='waiting' AND archived_at IS NULL "
        "AND updated_at < strftime('%s','now','-48 hours')"
    )
    long_waiting = c.fetchall()
    if long_waiting:
        lines = [f'- {r["id"]} ({r["title"][:50]}), {r["hours"]}h waiting' for r in long_waiting]
        tg_lines.append(f'{len(long_waiting)} kártya 48+ órája "waiting":\n' + '\n'.join(lines))
        audit_lines.append(f'LONG-WAITING ({len(long_waiting)}): ' + ', '.join(r['id'] for r in long_waiting))

    conn.close()

    if dry:
        print('--- DRY RUN, nothing written/sent ---')
        print(f'first_run={first_run} arch_level={arch_level} stuck_level={stuck_level}')
        print('\n'.join(audit_lines) if audit_lines else '(no findings)')
        print('\n--- WOULD SEND (Telegram) ---')
        print('\n\n'.join(tg_lines) if tg_lines else '(silent -- nothing to report)')
        return

    # State durability before any networked call.
    state['last_audit_at'] = int(time.time())
    state['stuck_pings'] = stuck_pings
    state['stuck_assignee'] = stuck_assignee
    notify.save_json_atomic(STATE_PATH, state)

    if audit_lines:
        notify.audit_log(LOG_PATH, [f'{int(time.time())} {ln}' for ln in audit_lines])

    if tg_lines and not first_run:
        text = '📋 Kanban-audit:\n\n' + '\n\n'.join(tg_lines)
        try:
            msg_id = notify.send_telegram(text)
            notify.daily_log_audit(AGENT_ID, f'## Kanban-audit ping (Bot API, ledger-audit)\n{text}')
            print(f'Telegram sent (msg {msg_id}).')
        except Exception as e:
            print(f'Telegram send failed: {e}', file=sys.stderr)
    elif tg_lines and first_run:
        print('first run: findings suppressed (no ping), watermark set.')
    elif audit_lines:
        print(f'{len(audit_lines)} audit-log line(s), no Telegram needed: ' + '; '.join(audit_lines))
    else:
        print('0 findings, silent run.')


def main():
    dry = '--dry-run' in sys.argv[1:]
    run(dry)


if __name__ == '__main__':
    main()
