#!/usr/bin/env python3
"""Deterministic 0-token pre-filter for the mail-heartbeat (hybrid stage 1).

Fetches recent mail from Laci's 4 watched M365 mailboxes, diffs each against a
per-mailbox watermark, classifies every NEW message with deterministic rules
(no LLM), and sends a single consolidated Telegram ping via the Bot API for the
messages that survive as important. In the common all-noise case it does no
outbound work at all -- this is where the token/cost saving comes from.

Design notes
- Stdlib only (json / re / os / sys / urllib) plus the local graph_mail_mcp
  module for the Graph read. No pip deps.
- State: store/mail-heartbeat-state.json -- {mailbox: last_seen ISO}. Same file
  the LLM heartbeat used, so the two are watermark-compatible.
- First run for a mailbox (key missing) => set watermark to newest, DON'T ping
  (backlog protection), identical to the LLM task's rule.
- Every classification is appended to store/mail-heartbeat/prefilter.log so the
  filter can be audited and tuned. Mail *content* is used only for this ping and
  the local audit log, never forwarded anywhere (hard rule).
- Audit-line format: `<received> [<mailbox>] <DECISION> <reason> | <from> | <subject>`.
  DECISION is PING or DROP; the daily safety-net greps ' DROP ' so EVERY drop
  (including the deterministic `outlook-junk` drop) is re-reviewed within 24h --
  no drop reason is ever excluded at query level. Notable reasons:
    outlook-junk          Outlook already moved the mail to Junk Email (its final
                          folder verdict) -> deterministic 0-token DROP; never
                          teaches the auto-blocklist.
    COLLISION collision:outlook-junk-vs-{never-drop,whitelist}
                          Outlook junked a mail our precedence still PINGs (a real
                          incident, or a whitelisted sender e.g. szamlazz.hu in
                          Junk) -> logged so the rule collision stays visible.
- Telegram Bot API bypasses the dashboard ledger hook; when we ping we also drop
  an audit line into the daily-log so session-continuity stays honest.

Modes
  (default)      normal run: diff vs watermark, ping survivors, advance state
  --dry-run      classify the diff and print, but DON'T send or write state
  --backfill-test [N]  reclassify the last N messages per mailbox regardless of
                 watermark, print the decision table, send nothing, write nothing
                 (use this to validate the rules before going live)
"""
import datetime
import fcntl
import json
import os
import re
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, '/home/kapucnis/.config/eliteai-graph')
import graph_mail_mcp as graph  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mail_model_escalation as mesc  # noqa: E402

MARVEEN_ROOT = '/home/kapucnis/marveen'
STATE_PATH = os.path.join(MARVEEN_ROOT, 'store', 'mail-heartbeat-state.json')
LOG_DIR = os.path.join(MARVEEN_ROOT, 'store', 'mail-heartbeat')
LOG_PATH = os.path.join(LOG_DIR, 'prefilter.log')
DASHBOARD_TOKEN_PATH = os.path.join(MARVEEN_ROOT, 'store', '.dashboard-token')
TG_ENV_PATH = os.path.expanduser('~/.claude/channels/telegram/.env')
TG_ACCESS_PATH = os.path.expanduser('~/.claude/channels/telegram/access.json')
API_BASE = 'http://localhost:3420'

WATCHED = ['k.laszlo@ebtkft.hu', 'penzugy@ebtkft.hu', 'kartya@ebtkft.hu', 'support@ebtkft.hu']
# Short label per mailbox for the ping line.
LABEL = {
    'k.laszlo@ebtkft.hu': 'Laci',
    'penzugy@ebtkft.hu': 'penzugy',
    'kartya@ebtkft.hu': 'kartya',
    'support@ebtkft.hu': 'support',
}

# --- Deterministic rule vocabulary -----------------------------------------
# ERROR / incident keywords -- ALWAYS important, overrides every noise rule.
ERROR_RE = re.compile(
    r'\b(hiba|hibabejelent|meghib|uzemzavar|üzemzavar|leall|leáll|kimarad|'
    r'aramszunet|áramszünet|nem m(u|ü)k(o|ö)d|riaszt|incident|outage|down|'
    r'error|failure|alarm|fault|szerviz)', re.IGNORECASE)

# Invoice / financial document -- important.
INVOICE_RE = re.compile(
    r'\b(szaml|száml|dijbeker|díjbeker|proforma|egyenlegk(o|ö)zl|befizet|'
    r'fizetesi felsz|fizetési felsz)', re.IGNORECASE)

# New business opportunity -- important, and overrides active-thread suppression.
OFFER_RE = re.compile(
    r'\b(ajanlatker|ajánlatkér|arajanlat|árajánlat|megrendel|uj rendel|'
    r'új rendel|beszerz)', re.IGNORECASE)

# Nina deal-lifecycle document (penzugy@ebtkft.hu ONLY): aláírt megrendelőlap
# or TIG (teljesítésigazolás) coming back as an attachment -- this is Nina's
# blind spot (2026-07-11, Yoda's design flagged it as the first blocker before
# any pilot deal). Graph's cheap $select doesn't expose attachment filenames,
# so has_attachments + a subject/preview keyword is the lowest-cost signal
# available; a false-negative here still falls through to the default
# human/partner-direct ping (nothing gets silently dropped), a false-positive
# just adds an extra tag, not a lost message.
NINA_DOC_RE = re.compile(
    r'\b(alairt|aláírt|megrendel(o|ő)lap|megrendeles visszaigazol|'
    r'megrendelés visszaigazol|teljesitesigazol|teljesítésigazol|\btig\b)',
    re.IGNORECASE)
NINA_MAILBOX = 'penzugy@ebtkft.hu'

# High-confidence NOISE: automated senders (matched on the from address).
NOISE_SENDER_RE = re.compile(
    r'(no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply|donotreply|notification|'
    r'newsletter|hirlevel|hírlevel|mailservice|cloudservices|mailer|bounce|'
    r'postmaster|marketing|cybernews|authentication-service)', re.IGNORECASE)

# Pure marketing / bulk domains observed in this account (drop as noise).
NOISE_DOMAINS = {
    'dreamjobs.hu', 'securifocus.com', 'barion.com', 'zenithen2.com',
    'mailservice.hikvision.com', 'cloudservices.hidglobal.com',
    'hidglobal.com', 'gls-hungary.com', 'tudjukki.hu', 'instantreklam.hu',
}

# Automated ticketing/notification-system senders -> DROP as noise (sender-based).
# 2026-07-14, Laci decision on jira@mbitech.atlassian.net: these are machine-
# generated JIRA notifications from a partner's ticketing system -> DROP as noise
# (option (b), analogous to the IPVM newsletter path). This rule runs in the NOISE
# stage (AFTER the error/nina/offer/invoice PING rules), so a JIRA ticket whose
# subject/preview trips ERROR_RE -- an actual incident that "ranunk is tartozik" --
# still PINGs; only routine ticket notifications drop. FAIL-SAFE by design.
# Grown ONLY via supervised feedback (like NEWSLETTER_DOMAINS); the localpart is
# anchored (^jira@) so a human at an atlassian.net tenant is never caught.
AUTOMATION_SENDER_RE = re.compile(
    r'^jira@(?:[\w-]+\.)*atlassian\.net$', re.IGNORECASE)

# Cold B2B sales-pitch outreach (typically mass/AI-generated marketing, not a
# real partner/customer contact) -- checked against subject+preview (blob),
# kept narrow so it can't shadow a genuine customer ajanlatker/megrendeles
# (2026-07-11, Laci flagged a netadclick@instantreklam.hu "hirlevelkuldes"
# pitch as AI-generated spam that slipped past as human/partner-direct).
# Drip-sequence self-reference patterns ("az elso ket levelben...", "elozo
# levelunkben...") added the same day (Laci: prod@neurisys-44.com "Dronjelek
# kezelese" pitch, caught only in the PREVIEW not the subject -- hence blob,
# not subj) -- an explicit numbered-sequence callback is a strong marketing-
# automation tell no single, real business email uses.
COLD_OUTREACH_RE = re.compile(
    r'(nincs ideje.{0,25}foglalkozni|mi megoldjuk( \S+nek)?!?\s*$|'
    r'szeretn(e|é)nk bemutatni|ingyenes (ajanlat|ajánlat|konzultaci|konzultáci|felmer|felmér)|'
    r'foglaljon( ingyenes)? id(o|ő)pontot|n(o|ö)velje a (bevetel|bevétel|forgalm)|'
    r'mutassuk be (o|ö)n(o|ö)knek|'
    r'az els(o|ő) (ke|ké)t lev(e|é)lben|el(o|ő)z(o|ő) lev(e|é)l(u|ü)nkben|'
    r'lev(e|é)l(sorozat|-sorozat)(u|ü)nkban)', re.IGNORECASE)

# --- Newsletter/marketing multi-signal drop (2026-07-11, Yoda's mail-prefilter
# strengthening plan, msg_id:322, GPT-crosscheck GO -- see
# store/self-audit/mail-prefilter-newsletter-ideation.md). Root cause: the 4
# false-positives that slipped through as human/partner-direct (alza.hu,
# atlassian.com, instantreklam.hu -- already covered above -- and kifli.hu)
# share NEWSLETTER-INFRASTRUCTURE fingerprints, not a common domain. One
# STRONG signal (alone sufficient) or 2+ INDEPENDENT weak signals (never one
# alone) triggers a drop. Runs in noise-stage (AFTER error/nina/offer/invoice
# ping rules), so a real incident/order/invoice can never be shadowed by this,
# even if its subject happens to contain a promo-ish word.

# S1 (STRONG): ESP preheader hidden-character padding. Verified against real
# preview data (2026-07-11): kifli.hu uses 0x034F (combining grapheme joiner)
# runs, alza.hu uses 0x200C (zero-width non-joiner) runs, both 50+ repeats
# AFTER the visible preview text -- exclusively an email-template artifact, no
# human-written or transactional email in the observed corpus has this.
ESP_PAD_RE = re.compile(r'(?:[͏​‌‍­﻿]\s*){8,}')

# S2 (STRONG): curated newsletter/marketing sender domains -- grown ONLY via
# the supervised feedback process (see daily-log/kanban), never auto-added.
# Dated comments mark which Laci-feedback case added each entry.
NEWSLETTER_DOMAINS = {
    'letter.alza.hu',      # 2026-07-11, Laci: "abszolút nem fontos, hírlevél"
    'e.atlassian.com',     # 2026-07-11, Yoda mail-prefilter analysis
    'kifli.hu',             # 2026-07-11, Laci: "abszolút nem fontos, hírlevél"
}

# W1 (weak): marketing/ESP-style sender subdomain. Deliberately EXCLUDES
# 'mail' and 'info' -- both have real transactional/partner senders in the
# corpus (mail.anico.hu order confirmations; info@trikdis.hu, info@smartsec.hu
# -- the latter sends invoices).
MARKETING_SUBDOMAIN_RE = re.compile(
    r'@(?:[\w-]+\.)*(?:letter|news|newsletter|em|mkt|marketing|go|links|click|campaign|broadcast)\.[\w.-]+$',
    re.IGNORECASE)

# W2 (weak): promo/sale subject-or-preview keywords (HU+EN).
PROMO_RE = re.compile(
    r'(akci(o|ó)s?\b|kedvezm(e|é)ny|kupon|le(a|á)raz|(a|á)rpar(a|á)d|nyerem(e|é)ny|'
    r'black friday|fekete p(e|é)ntek|ingyenes sz(a|á)ll(i|í)t|webin(a|á)r|\bsale\b|'
    r'%\s*(kedvezm|off)|last chance|limited (time|offer)|ne maradjon le|ne hagyja ki|'
    r"don.t miss|register now)", re.IGNORECASE)

# W3 (weak): emoji in the subject line or display name.
EMOJI_RE = re.compile('[\U0001F000-\U0001FAFF☀-➿⬀-⯿]')

# W4 (weak): newsletter-style localpart. 'info' deliberately excluded (see W1).
NEWSLETTER_LOCALPART_RE = re.compile(r'^(news|newsletter|hirlevel|marketing|promo|deals|offers)[@.]', re.IGNORECASE)

# W5 (weak): unsubscribe trace in the preview text.
UNSUBSCRIBE_RE = re.compile(r'(leiratkoz|unsubscribe|opt[- ]?out)', re.IGNORECASE)

# Auto-reply / out-of-office: NEVER actionable, drop before every other rule
# (an out-of-office whose subject echoes "megrendelés"/"hiba" is still noise).
AUTOREPLY_RE = re.compile(
    r'(automatikus v(a|á)lasz|automatic reply|out of office|out-of-office|'
    r'szabads(a|á)gon|auto[- ]?reply|nem tart(o|ó)zkodom)', re.IGNORECASE)

# Other automated subject patterns (OTP, registration-thankyou, delivery/device
# notifications, order-status autos).
NOISE_SUBJECT_RE = re.compile(
    r'(verification code|login code|one[- ]time|otp\b|'
    r'k(o|ö)sz(o|ö)nj(u|ü)k.{0,6}regisztr|thank you for registering|'
    r'delivery notification|device registered|registered notification|'
    r'(a|á)llapota megv(a|á)ltoz|rendel(e|é)s (a|á)llapota)', re.IGNORECASE)

# Pure acknowledgement (no actionable content): short body, no question mark.
ACK_RE = re.compile(r'^\s*(k(o|ö)sz(i|önöm)?|rendben|ok(e|é)?|k(e|é)sz|szuper|'
                    r'thx|thanks|thank you)[\s.!]*$', re.IGNORECASE)


def newsletter_signal(mail, subj, prev, frm, blob):
    """Return a DROP reason string if this looks like a newsletter/marketing
    send, else None. One STRONG signal (S1/S2) is sufficient; weak signals
    (W1-W5) require 2+ independent ones -- a single weak signal never drops.
    """
    domain = domain_of(frm)
    from_name = mail.get('from_name') or ''

    if ESP_PAD_RE.search(prev):
        return 'newsletter(S1:esp-padding)'
    if domain in NEWSLETTER_DOMAINS:
        return 'newsletter(S2:known-domain)'

    weak = []
    if MARKETING_SUBDOMAIN_RE.search(frm):
        weak.append('W1:subdomain')
    if PROMO_RE.search(blob):
        weak.append('W2:promo-word')
    if EMOJI_RE.search(subj) or EMOJI_RE.search(from_name):
        weak.append('W3:emoji')
    if NEWSLETTER_LOCALPART_RE.search(frm):
        weak.append('W4:localpart')
    if UNSUBSCRIBE_RE.search(prev):
        weak.append('W5:unsubscribe')
    if len(weak) >= 2:
        return f'newsletter({"+".join(weak)})'
    return None


def norm_subject(subj):
    """Lowercase and strip leading Re:/Fw:/Fwd: chains for thread matching."""
    s = (subj or '').strip()
    while True:
        m = re.match(r'^\s*(re|fw|fwd|vá|vá:|válasz)\s*:\s*', s, re.IGNORECASE)
        if not m:
            break
        s = s[m.end():]
    return s.strip().lower()


def domain_of(addr):
    a = (addr or '').lower()
    return a.split('@', 1)[1] if '@' in a else ''


def classify(mail, mailbox_mails):
    """Return (decision, reason) where decision is 'PING' or 'DROP'.

    mailbox_mails: all recently-fetched mails in the same mailbox (for
    active-thread detection). The ERROR override runs first so an incident from
    an automated monitoring sender is never dropped.
    """
    subj = mail.get('subject') or ''
    prev = mail.get('preview') or ''
    frm = (mail.get('from') or '').lower()
    blob = f'{subj}\n{prev}'

    # 0. Own outgoing -- never ping Laci about his own sent mail.
    if frm in WATCHED:
        return 'DROP', 'own-outgoing'

    # 0b. Auto-reply / out-of-office -- never actionable, drop before the
    #     importance rules so a "megrendelés"/"hiba" echo can't re-surface it.
    if AUTOREPLY_RE.search(subj):
        return 'DROP', 'auto-reply'

    # 1. ERROR / incident -- MINDIG FONTOS, overrides all noise rules.
    if ERROR_RE.search(blob):
        return 'PING', 'error/incident'

    # 2. Nina deal-lifecycle document (penzugy@ only) -- checked BEFORE the
    #    generic offer/order rule so a returning signed order-form/TIG gets
    #    the specific, actionable tag instead of the generic 'offer/order'.
    if mail.get('mailbox') == NINA_MAILBOX and mail.get('has_attachments') and NINA_DOC_RE.search(blob):
        return 'PING', 'nina/megrendelolap-tig'

    # 3. New business opportunity -- important, overrides thread suppression.
    if OFFER_RE.search(blob):
        return 'PING', 'offer/order'

    # 4. Invoice / financial document.
    if INVOICE_RE.search(blob):
        return 'PING', 'invoice'

    # 5. High-confidence noise -> DROP.
    if NOISE_SENDER_RE.search(frm):
        return 'DROP', 'noise-sender'
    if domain_of(frm) in NOISE_DOMAINS:
        return 'DROP', 'noise-domain'
    if AUTOMATION_SENDER_RE.search(frm):
        return 'DROP', 'automation-ticketing'
    if NOISE_SUBJECT_RE.search(blob):
        return 'DROP', 'noise-subject'
    if COLD_OUTREACH_RE.search(blob):
        return 'DROP', 'cold-outreach-pitch'
    newsletter_reason = newsletter_signal(mail, subj, prev, frm, blob)
    if newsletter_reason:
        return 'DROP', newsletter_reason
    if ACK_RE.match(prev.strip()):
        return 'DROP', 'pure-ack'

    # 6. Active-thread suppression: if Laci already has an outgoing mail on this
    #    same subject in this mailbox, he is handling it live -- a plain
    #    status-update reply is not worth a ping. (Error/offer already returned
    #    above, so those still surface.)
    ns = norm_subject(subj)
    for other in mailbox_mails:
        if other is mail:
            continue
        if (other.get('from') or '').lower() in WATCHED and norm_subject(other.get('subject')) == ns:
            return 'DROP', 'active-thread(laci-handling)'

    # 7. Default: a real human/partner mail directly to a watched mailbox that
    #    matched none of the drop rules -> surface it.
    return 'PING', 'human/partner-direct'


# --- IO helpers -------------------------------------------------------------
def load_state():
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH) as f:
            return json.load(f)
    return {}


def save_state(state):
    tmp = STATE_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f, indent=1, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, STATE_PATH)


def audit_log(lines):
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(LOG_PATH, 'a') as f:
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


def daily_log_audit(content):
    """Manual ledger audit -- Bot API bypasses the PostToolUse ledger hook."""
    with open(DASHBOARD_TOKEN_PATH) as f:
        token = f.read().strip()
    payload = json.dumps({'agent_id': 'eliteai', 'content': content}).encode()
    req = urllib.request.Request(
        API_BASE + '/api/daily-log', data=payload, method='POST',
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'})
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            json.load(resp)
    except Exception as e:  # audit is best-effort; never block the ping on it
        print(f'daily-log audit failed: {e}', file=sys.stderr)


def hm(iso):
    """ISO Z -> HH:MM in Europe/Budapest (UTC+2 CEST). Cheap fixed offset; the
    heartbeat only runs in summer work hours so DST math is not worth a tz dep."""
    m = re.search(r'T(\d{2}):(\d{2})', iso or '')
    if not m:
        return '??:??'
    h = (int(m.group(1)) + 2) % 24
    return f'{h:02d}:{m.group(2)}'


def _now_iso():
    """UTC timestamp for auto-blocklist audit entries (stable, tz-explicit)."""
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def fetch_by_mailbox(top):
    """Return (by_mailbox, errored_mailboxes). Graph auth/token failures come
    back as rows carrying an 'error' key (not exceptions); we surface those so a
    persistent outage can trip the task's failThreshold instead of going silent.
    """
    rows = graph.list_recent_all(top)
    by = {mb: [] for mb in WATCHED}
    errored = set()
    for r in rows:
        mb = r.get('mailbox')
        if mb not in by:
            continue
        if r.get('error') is not None or 'error' in r and not r.get('received'):
            errored.add(mb)
        elif r.get('received'):
            by[mb].append(r)
    return by, errored


# --- Runners ----------------------------------------------------------------
def run_backfill_test(n):
    by, errored = fetch_by_mailbox(n)
    if errored:
        print(f'(fetch error on: {", ".join(sorted(errored))})')
    print(f'BACKFILL-TEST (last {n}/mailbox, no send, no state write)\n')
    for mb in WATCHED:
        print(f'=== {mb} ===')
        for mail in sorted(by[mb], key=lambda r: r['received'], reverse=True):
            dec, reason = classify(mail, by[mb])
            mark = 'PING' if dec == 'PING' else '  . '
            print(f'  {mark} {hm(mail["received"])} {reason:28s} {mail.get("from")}  ::  {(mail.get("subject") or "")[:55]}')
        print()


def acquire_lock():
    """Non-blocking flock so two overlapping scheduler ticks can't double-ping.
    Returns the held file object (keep it referenced) or None if another
    instance holds the lock -- caller then exits cleanly."""
    os.makedirs(LOG_DIR, exist_ok=True)
    fh = open(os.path.join(LOG_DIR, 'prefilter.lock'), 'w')
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
    state = load_state()
    by, errored = fetch_by_mailbox(40)
    # If EVERY mailbox failed to fetch, this is a real Graph/auth outage: leave
    # state untouched and exit non-zero so the task's failThreshold can alarm on
    # a sustained outage. A partial failure just skips the errored mailbox(es).
    if errored and all(not by[mb] for mb in WATCHED):
        print(f'FETCH FAILURE (all mailboxes): {", ".join(sorted(errored))} -- state untouched', file=sys.stderr)
        if not dry:
            sys.exit(2)
        return
    survivors = []          # (mailbox, mail, reason)
    borderline = []         # (mailbox, mail, orig_reason) -- deferred to the model
    new_max = {}            # mailbox -> max received this run
    first_run = {}          # mailbox -> bool
    audit_lines = []

    # Model-escalation layer state (Yoda spec msg 563). classify() is untouched;
    # this wraps its output. A missing/corrupt config falls back to SHADOW-ON so
    # the model can never silently drop before the burn-in blesses it.
    model_cfg = mesc.load_model_config()
    blocklist = mesc.load_blocklist()

    for mb in WATCHED:
        mails = by[mb]
        if not mails:
            continue
        mx = max(m['received'] for m in mails)
        new_max[mb] = mx
        wm = state.get(mb)
        first_run[mb] = wm is None
        if wm is None:
            # First run for this mailbox: set watermark, do not ping (backlog).
            continue
        for mail in mails:
            if mail['received'] <= wm:
                continue
            dec, reason = classify(mail, mails)
            frm = (mail.get('from') or '').lower()
            domain = domain_of(frm)
            if model_cfg['enabled']:
                # Outlook-junk signal (envelope metadata from the graph read).
                # Gated by junk_drop_enabled; the raw flag still drives the
                # collision log so a whitelisted/incident mail junked by Outlook
                # stays visible even if the junk-DROP is switched off.
                raw_junk = bool(mail.get('is_junk'))
                effective_junk = raw_junk and model_cfg['junk_drop_enabled']
                fdec, freason, needs_model = mesc.wrapper_decision(
                    dec, reason, frm, domain, blocklist, NOISE_DOMAINS, NOISE_SENDER_RE,
                    is_junk=effective_junk)
                coll = mesc.junk_collision(reason, frm, domain, raw_junk)
                if coll:
                    audit_lines.append(
                        f'{mail["received"]} [{mb}] COLLISION {coll} | {mail.get("from")} | {(mail.get("subject") or "")[:70]}')
            else:
                # Kill switch: behave exactly like the pre-model deterministic filter.
                fdec, freason, needs_model = dec, reason, False
            if needs_model:
                borderline.append((mb, mail, reason))
                continue        # decision (and audit line) finalised after the batch
            audit_lines.append(
                f'{mail["received"]} [{mb}] {fdec} {freason} | {mail.get("from")} | {(mail.get("subject") or "")[:70]}')
            if fdec == 'PING':
                survivors.append((mb, mail, freason))

    # Sustained Outlook-junk folder-resolution failure alert (GPT-ideation pt 2).
    # If the junk-folder lookup fails for JUNK_FAIL_ALERT_THRESHOLD consecutive
    # runs the junk-DROP goes inert (everything PINGs, fail-safe) -- alert so a
    # persistent outage (API limit, permission change) does not degrade unnoticed.
    junk_alerts = []
    if model_cfg['junk_drop_enabled']:
        junk_state = mesc.load_junk_state()
        for mb in WATCHED:
            if not by[mb]:
                continue    # nothing fetched -> no signal about this mailbox's junk resolution
            failed = any(m.get('junk_unresolved') for m in by[mb])
            junk_state[mb], should_alert = mesc.junk_alert_transition(junk_state.get(mb, {}), failed)
            if should_alert:
                junk_alerts.append(mb)
        if not dry:
            mesc.save_junk_state(junk_state)

    # --- Model escalation for the borderline set (batched, fail-safe) --------
    # One model call per run. Overflow past MAX_BATCH pings without the model.
    # In dry-run we never spend tokens: borderline is shown as a pending PING.
    new_blocklisted = []    # (domain, verdict_meta, mail) -- for the T9 notification
    cap_hit = []            # (mb, mail) spam-verdicts NOT dropped because the daily cap was reached
    if borderline:
        to_model = borderline[:mesc.MAX_BATCH]
        overflow = borderline[mesc.MAX_BATCH:]
        for mb, mail, reason in overflow:
            survivors.append((mb, mail, reason + '/overflow-pingsafe'))
            audit_lines.append(
                f'{mail["received"]} [{mb}] PING {reason}/overflow-pingsafe | {mail.get("from")} | {(mail.get("subject") or "")[:70]}')
        if dry:
            verdicts = {}       # do not call the model in dry-run (0-token)
        else:
            verdicts = mesc.classify_borderline_batch([m for (_, m, _) in to_model])
        # F-2: cap new auto-blocklist entries per day (envelope-spoof-DoS residual
        # risk). Seed from entries already added today, count up as we add.
        added_today = mesc.blocklist_additions_today(_now_iso()[:10])
        for i, (mb, mail, reason) in enumerate(to_model):
            v = verdicts.get(i)
            domain = domain_of((mail.get('from') or '').lower())
            is_spam = bool(v and v['verdict'] == 'spam' and v['confidence'] >= model_cfg['conf_threshold'])
            if is_spam and model_cfg['shadow']:
                # Shadow/burn-in: log what we WOULD drop, but still PING and do
                # not touch the blocklist -- observe the model with zero effect.
                tag = f"{reason}->SHADOW-would-drop(spam {v['confidence']:.2f})"
                survivors.append((mb, mail, tag))
                audit_lines.append(
                    f'{mail["received"]} [{mb}] PING {tag} | {mail.get("from")} | {(mail.get("subject") or "")[:70]}')
            elif is_spam and added_today >= mesc.DAILY_BLOCKLIST_CAP:
                # F-2: daily cap reached -> do NOT drop, PING instead + flag notify.
                survivors.append((mb, mail, f'{reason}->model-spam-but-daily-cap({added_today})-pingsafe'))
                cap_hit.append((mb, mail))
                audit_lines.append(
                    f'{mail["received"]} [{mb}] PING {reason}->daily-cap-pingsafe | {mail.get("from")} | {(mail.get("subject") or "")[:70]}')
            elif is_spam:
                # Live: drop AND remember the ENVELOPE domain (K-2, code-decided).
                added = dry is False and mesc.add_blocklist_entry(
                    domain, v,
                    {'from': mail.get('from'), 'subject': mail.get('subject')},
                    _now_iso())
                audit_lines.append(
                    f"{mail['received']} [{mb}] DROP {reason}->model-spam({v['confidence']:.2f}) | {mail.get('from')} | {(mail.get('subject') or '')[:70]}")
                if added:
                    added_today += 1
                    new_blocklisted.append((domain, v, mail))
            else:
                # legit / unsure / low-confidence / model failure -> PING (fail-safe).
                # F-3: distinguish the deliberate dry-run skip from a real failure.
                if dry:
                    tag = 'model-skipped(dry-run)'
                elif v is None:
                    tag = 'model-fail'
                else:
                    tag = f"model:{v['verdict']}({v['confidence']:.2f})"
                survivors.append((mb, mail, f'{reason}->{tag}-ping'))
                audit_lines.append(
                    f'{mail["received"]} [{mb}] PING {reason}->{tag} | {mail.get("from")} | {(mail.get("subject") or "")[:70]}')

    # Build the consolidated ping (grouped by mailbox, newest first).
    msg_id = None
    if survivors:
        lines = ['📧 Mail elő-szűrő -- fontos új levél:']
        for mb in WATCHED:
            grp = [(m, r) for (x, m, r) in survivors if x == mb]
            if not grp:
                continue
            grp.sort(key=lambda t: t[0]['received'], reverse=True)
            for mail, reason in grp:
                who = mail.get('from_name') or mail.get('from')
                subj = (mail.get('subject') or '').strip()
                lines.append(f'[{hm(mail["received"])}] ({LABEL[mb]}) {who} -- {subj}  ({reason})')
        text = '\n'.join(lines)
        if dry:
            print('--- WOULD SEND ---')
            print(text)
        else:
            msg_id = send_telegram(text)

    if dry:
        print('\n--- classifications ---')
        print('\n'.join(audit_lines) if audit_lines else '(no new mail past watermark)')
        print('\n--- WOULD SET watermarks ---')
        for mb in WATCHED:
            print(f'  {mb}: {new_max.get(mb, state.get(mb))}')
        return

    # Persist watermarks IMMEDIATELY after the ping, before the (networked)
    # daily-log audit -- so a crash in the audit call can't cause the next run
    # to re-ping the same mail. State durability beats audit durability here.
    for mb, mx in new_max.items():
        state[mb] = mx
    save_state(state)
    if audit_lines:
        audit_log(audit_lines)

    # Best-effort ledger audit (Bot API bypasses the PostToolUse hook). Runs
    # after state is durable; a failure here only costs an audit line.
    if survivors:
        model_note = f'{len(borderline)} hataréset modell-osztalyozva' if borderline else '0 modell-token'
        daily_log_audit(
            f'## {hm(new_max.get(WATCHED[0], ""))} -- Mail elő-szűrő ping (Bot API, ledger-audit)\n'
            f'{len(survivors)} fontos levél jelezve (msg {msg_id}). Pre-filter ({model_note}).\n'
            + '\n'.join(f'- ({LABEL[mb]}) {m.get("from")} :: {(m.get("subject") or "")[:60]} [{r}]'
                        for mb, m, r in survivors))

    # T9: notify + audit whenever the model adds a NEW domain to the auto-blocklist
    # so Laci/EliteAI can review and reverse a false positive (reversibility).
    if new_blocklisted:
        note = ['🚫 Mail elő-szűrő -- modell új spam-domaint tiltólistázott (auto-blocklist):']
        for domain, v, mail in new_blocklisted:
            note.append(f'- {domain} (conf {v["confidence"]:.2f}) :: {mail.get("from")} -- {(mail.get("subject") or "")[:50]}')
        # F-2: spoof-awareness + explicit reversal instruction in the notice.
        note.append('Ha ez valós partner-domain, a feladó spoofolt lehetett -- törlés: '
                    'bejegyzés ki a store/mail-heartbeat/auto-blocklist.json-ból.')
        try:
            send_telegram('\n'.join(note))
        except Exception as e:  # notification is best-effort; the entry still stands
            print(f'blocklist notify failed: {e}', file=sys.stderr)
        # F-1: the model reason is untrusted-origin -> render it with a code-side
        # provenance prefix (K-4-on-return); _sanitize_reason already stripped [].
        daily_log_audit(
            f'## {hm(new_max.get(WATCHED[0], ""))} -- Auto-blocklist bővítés (modell)\n'
            + '\n'.join(f'- {domain} conf {v["confidence"]:.2f} [{mesc.provenance_reason(v.get("reason"))}] :: {mail.get("from")}'
                        for domain, v, mail in new_blocklisted))

    # F-2: separate notice when the per-day cap held back one or more spam-verdicts
    # (they PINGed instead of dropping) -- so a spoof-flood can't silently mass-add.
    if cap_hit:
        try:
            send_telegram(
                f'⚠️ Mail elő-szűrő -- napi auto-blocklist sapka ({mesc.DAILY_BLOCKLIST_CAP}/nap) elérve. '
                f'{len(cap_hit)} további spam-ítélet NEM lett tiltva, PING-elve lett (fail-safe). '
                f'Ha valódi spam-hullám: kézi ellenőrzés ajánlott.')
        except Exception as e:
            print(f'cap notify failed: {e}', file=sys.stderr)

    # GPT-ideation pt 2: sustained junk-folder-resolution failure -> alert once.
    if junk_alerts:
        try:
            send_telegram(
                f'⚠️ Mail elő-szűrő -- az Outlook-junk folder-feloldás {mesc.JUNK_FAIL_ALERT_THRESHOLD}+ '
                f'egymást követő futáson hibázott ({", ".join(junk_alerts)}). A junk-DROP addig inaktív '
                f'(minden PING, fail-safe), de tartós hiba (API-limit / jogosultság-változás) '
                f'észrevétlenül rontja a szűrést -- érdemes ellenőrizni.')
        except Exception as e:
            print(f'junk-resolve alert failed: {e}', file=sys.stderr)

    # Stdout summary (goes to the command task's logfile).
    fr = [mb for mb, v in first_run.items() if v]
    if survivors:
        print(f'{len(survivors)} PING (msg {msg_id}); new past watermark logged.')
    elif audit_lines:
        print(f'0 PING, {len(audit_lines)} dropped as noise.')
    if fr:
        print(f'first-run watermark set (no ping): {", ".join(fr)}')


def main():
    args = sys.argv[1:]
    if args and args[0] == '--backfill-test':
        n = int(args[1]) if len(args) > 1 else 15
        run_backfill_test(n)
    elif args and args[0] == '--dry-run':
        run(dry=True)
    else:
        run(dry=False)


if __name__ == '__main__':
    main()
