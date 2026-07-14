"""Shared stdlib-only helpers for deterministic (type=command) scheduled tasks:
Telegram Bot API send + best-effort dashboard daily-log audit + atomic JSON
state read/write. Factored out of scripts/mail_prefilter.py (2026-07-10) when
scripts/kanban_audit.py needed the same primitives, so the pattern doesn't
duplicate a third time.

Command-type tasks have no Claude Code session/tool access, so they cannot use
the dashboard `reply` tool (that's a Claude Code MCP tool, not an HTTP
endpoint) -- they talk to the Telegram Bot API directly, which bypasses the
PostToolUse ledger hook. The daily_log_audit() call below is how these scripts
keep the session-continuity ledger honest despite that bypass.
"""
import json
import os
import re
import urllib.parse
import urllib.request

MARVEEN_ROOT = '/home/kapucnis/marveen'
DASHBOARD_TOKEN_PATH = os.path.join(MARVEEN_ROOT, 'store', '.dashboard-token')
TG_ENV_PATH = os.path.expanduser('~/.claude/channels/telegram/.env')
TG_ACCESS_PATH = os.path.expanduser('~/.claude/channels/telegram/access.json')
API_BASE = 'http://localhost:3420'


def load_json(path, default):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def save_json_atomic(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)


def audit_log(log_path, lines):
    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    with open(log_path, 'a') as f:
        for ln in lines:
            f.write(ln + '\n')


def tg_credentials():
    token = None
    with open(TG_ENV_PATH) as f:
        for line in f:
            m = re.match(r'\s*(?:TELEGRAM_BOT_TOKEN|BOT_TOKEN)\s*=\s*(.+?)\s*$', line)
            if m:
                token = m.group(1).strip().strip('"\'')
    with open(TG_ACCESS_PATH) as f:
        chat_id = json.load(f)['allowFrom'][0]
    return token, chat_id


def send_telegram(text):
    token, chat_id = tg_credentials()
    data = urllib.parse.urlencode({'chat_id': chat_id, 'text': text}).encode()
    req = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/sendMessage', data=data, method='POST')
    with urllib.request.urlopen(req, timeout=25) as resp:
        d = json.load(resp)
    if not d.get('ok'):
        raise RuntimeError(f'telegram send failed: {d.get("description")}')
    return d['result']['message_id']


def daily_log_audit(agent_id, content):
    """Manual ledger audit -- Bot API bypasses the PostToolUse ledger hook."""
    with open(DASHBOARD_TOKEN_PATH) as f:
        token = f.read().strip()
    payload = json.dumps({'agent_id': agent_id, 'content': content}).encode()
    req = urllib.request.Request(
        API_BASE + '/api/daily-log', data=payload, method='POST',
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            json.load(resp)
    except Exception as e:  # audit is best-effort; never block the caller on it
        import sys
        print(f'daily-log audit failed: {e}', file=sys.stderr)


def send_inter_agent(from_agent, to_agent, content):
    with open(DASHBOARD_TOKEN_PATH) as f:
        token = f.read().strip()
    payload = json.dumps({'from': from_agent, 'to': to_agent, 'content': content}).encode()
    req = urllib.request.Request(
        API_BASE + '/api/messages', data=payload, method='POST',
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)
