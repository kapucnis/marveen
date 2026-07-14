#!/usr/bin/env python3
"""T0 offline replay harness (Yoda spec msg 772) -- compare the OLD spam-classifier
prompt vs the NEW attention-triage prompt on a curated, ground-truth-labelled set
drawn from real burn-in cases (JIRA, IPVM, Zabbix, cold pitches, a real quote, a
newsletter). Runs the real fleet Haiku via mesc.call_model (needs the OAuth token).

Acceptance (Yoda): (a) JIRA-type mails -> noise>=0.95 under the NEW prompt;
(b) ZERO important-loss on ground-truth-important mails; (c) spam side no regression.

This is a one-off evaluation tool, NOT part of the runtime pipeline. Run:
  python3 scripts/mail_escalation_t0_replay.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mail_model_escalation as mesc  # noqa: E402

# The OAuth token lives in the main repo store/, not the worktree -- point there.
mesc.OAUTH_TOKEN_PATH = '/home/kapucnis/marveen/store/.claude-oauth-token'
mesc.HB_DIR = '/home/kapucnis/marveen/store/mail-heartbeat'
mesc.EMPTY_MCP_PATH = os.path.join(mesc.HB_DIR, 'model-mcp-empty.json')

# --- ground-truth labelled set (curated from real burn-in cases) --------------
# expected_new is the NEW-taxonomy ground truth; expected_old_ok lists the OLD
# verdicts that would have been "acceptable" (not a miss) under the 3-label scheme.
CASES = [
    dict(frm='jira@mbitech.atlassian.net', name='Jira', subject='[JIRA] (TC-72534) JIRA ertesites',
         preview='A ticket status changed to In Progress.', gt='noise', kind='jira'),
    dict(frm='info@ipvm.com', name='IPVM', subject='Daily: 32 News Briefs',
         preview='Today\'s physical security news digest. Unsubscribe any time.', gt='noise', kind='newsletter'),
    dict(frm='info@kifli.hu', name='Kifli', subject='Akcios grilltermekek a hetvegere',
         preview='30% kedvezmeny a grillekre, ne maradjon le! Leiratkozas.', gt='noise', kind='newsletter'),
    dict(frm='tpzbx@alert.talentisprotect.com', name='Zabbix', subject='Problem: Windows CPU queue length too high',
         preview='Zabbix detected an issue on host WIN-DC01. Severity: warning.', gt='important', kind='incident'),
    dict(frm='neked@proaktivdirekt.com', name='', subject='Lassunk at a korlatainkon',
         preview='Uvegkorlatok gyartasa, szerelese, tobb mint tiz eves szakmai tapasztalattal.', gt='spam', kind='pitch'),
    dict(frm='prod@connectiva-3.com', name='', subject='Egyuttmukodesi lehetoseg',
         preview='Bemutatnank a cegunket es a szolgaltatasainkat, egyeztetnenk egy idopontot.', gt='spam', kind='pitch'),
    dict(frm='beszerzes@nagyugyfel.hu', name='Nagy Ugyfel Kft', subject='Arajanlatot kernenk 3 kamerara',
         preview='A korabbi egyeztetes alapjan szeretnenk arajanlatot kerni 3 db kulteri kamerara.', gt='important', kind='quote'),
    dict(frm='kapcsolattarto@partnerceg.hu', name='Partner Kft', subject='Kerdes a jovo heti telepitesrol',
         preview='Szia, egyeztetnenk a jovo heti telepites idopontjat, visszajeleznel?', gt='important', kind='human'),
]

OLD_HEADER = [
    "You are a strict spam classifier for EBT, a Hungarian security-systems "
    "company. You are given BORDERLINE emails a deterministic rule-filter "
    "could not confidently decide. For EACH email choose exactly one verdict:",
    '  "spam"   = cold mass-outreach / AI-generated sales pitch / bulk '
    'marketing, NOT a real customer, partner or supplier.',
    '  "legit"  = a real customer/partner/supplier, a genuine order, '
    'invoice, quote request, or human correspondence.',
    '  "unsure" = you cannot tell.',
    "Be CONSERVATIVE: when a real business email is plausible, prefer "
    "\"legit\" or \"unsure\" over \"spam\".",
]


def build_old_prompt(mails, nonce):
    parts = list(OLD_HEADER)
    parts += ["", mesc.UNTRUSTED_NOTICE.format(nonce=nonce), "",
              "Return ONLY a JSON array, one object per email:",
              '  [{"n":1,"verdict":"spam|legit|unsure","confidence":0.0-1.0,"reason":"<=12 words"}, ...]',
              "", "EMAILS:"]
    for i, m in enumerate(mails, 1):
        parts.append(f'<email nonce="{nonce}" n="{i}">')
        parts.append(f'From: {m.get("from")} ({m.get("from_name")})')
        parts.append(f'Subject: {m.get("subject")}')
        parts.append(f'Preview: {m.get("preview")}')
        parts.append(f'</email nonce="{nonce}">')
    return '\n'.join(parts)


def run(label, build_fn):
    mails = [dict(**{'from': c['frm'], 'from_name': c['name'],
                     'subject': c['subject'], 'preview': c['preview']}) for c in CASES]
    nonce = os.urandom(6).hex()
    prompt = build_fn(mails, nonce)
    raw = mesc.call_model(prompt)
    if raw is None:
        print(f'[{label}] MODEL CALL FAILED (no token / spawn / parse) -- cannot replay')
        return None
    by_n = mesc.parse_verdicts(raw, len(mails))
    return {n - 1: meta for n, meta in by_n.items()}


def main():
    print('=== T0 OFFLINE REPLAY: old spam-classifier vs new attention-triage ===\n')
    old = run('OLD', build_old_prompt)
    new = run('NEW', mesc.build_prompt)
    if old is None or new is None:
        sys.exit(2)

    hdr = f'{"case":10} {"kind":10} {"ground-truth":13} {"OLD":22} {"NEW":22}'
    print(hdr)
    print('-' * len(hdr))
    jira_ok = True
    important_loss = []
    spam_regress = []
    for i, c in enumerate(CASES):
        o = old.get(i, {})
        n = new.get(i, {})
        ov = f'{o.get("verdict","-")}({o.get("confidence",0):.2f})'
        nv = f'{n.get("verdict","-")}({n.get("confidence",0):.2f})'
        name = c['name'] or c['frm'].split('@')[0]
        print(f'{name[:10]:10} {c["kind"]:10} {c["gt"]:13} {ov:22} {nv:22}')
        # acceptance checks on the NEW prompt
        if c['kind'] == 'jira':
            if not (n.get('verdict') == 'noise' and n.get('confidence', 0) >= 0.95):
                jira_ok = False
        if c['gt'] == 'important':
            # important-loss = the NEW prompt would DROP it (noise/spam high-conf)
            if n.get('verdict') in ('noise', 'spam') and n.get('confidence', 0) >= 0.95:
                important_loss.append(name)
        if c['gt'] == 'spam':
            # regression = OLD caught it as spam but NEW no longer does
            old_spam = o.get('verdict') == 'spam'
            new_spam = n.get('verdict') == 'spam'
            if old_spam and not new_spam:
                spam_regress.append(name)

    print('\n=== ACCEPTANCE (Yoda) ===')
    print(f'(a) JIRA-type -> noise>=0.95 under NEW prompt: {"PASS" if jira_ok else "FAIL"}')
    print(f'(b) ZERO important-loss on ground-truth-important: '
          f'{"PASS" if not important_loss else "FAIL " + str(important_loss)}')
    print(f'(c) spam side no regression vs OLD: '
          f'{"PASS" if not spam_regress else "FAIL " + str(spam_regress)}')


if __name__ == '__main__':
    main()
