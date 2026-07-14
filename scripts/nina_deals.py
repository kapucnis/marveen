#!/usr/bin/env python3
"""Deterministic, gate-validated helper for Nina's deal-lifecycle ledger.

store/nina/deals.json is the MASTER record of every EBT deal Nina tracks
(schema + state machine defined by Yoda's design in agents/nina/CLAUDE.md,
2026-07-10). This script is the ONLY sanctioned way to write that file --
Nina (and anyone else) must go through it, never hand-edit the JSON. Every
mutating command:
  1. acquires an exclusive file lock (store/nina/.deals.lock)
  2. backs up the current deals.json to store/nina/backups/ before writing
  3. validates the requested change against the deal-level state machine
     (or the tig-szakasz sub-lifecycle) and HARD-REJECTS invalid transitions
  4. appends a `tortenet` (history) entry with timestamp + forras + note
  5. writes atomically (tmp + os.replace)

Deal-level statusz enum (ordinal progression, with side-exits):
  ajanlat_kesz -> megrendelve -> kivitelezes -> reszteljesitve* -> tig_tervezet
  -> tig_kikuldve -> tig_alairva -> szamlazasra_kesz -> szamla_kikuldve
  -> fizetve
  Side-exits (from any non-terminal state): lost, elavult
  szamla_kikuldve -> lejart (overdue marker) -> fizetve (paid late)
  * reszteljesitve can loop back to kivitelezes (next phase) or advance to
    tig_tervezet for the completed phase's TIG.
  fizetve / lost / elavult are terminal -- no further transitions.

TIG-szakasz sub-lifecycle (each deal has a `tig` LIST -- partial completion
means multiple independent TIG+szamla pairs on one deal):
  open (dok_hianylista) -> [hianylista updates] -> tervezet keszen (only when
  dok_hianylista empty) -> kikuldve -> alairva -> szamla adatlap -> szamla
  kikuldve -> szamla fizetve

Usage: see `--help` on each subcommand. `--backfill-test`-style dry inspection
is just `nina_deals.py show <deal_id>` / `list` (read-only, no lock needed).
"""
import argparse
import fcntl
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/home/kapucnis/marveen")
DEALS_PATH = ROOT / "store" / "nina" / "deals.json"
BACKUP_DIR = ROOT / "store" / "nina" / "backups"
LOCK_PATH = ROOT / "store" / "nina" / ".deals.lock"
BACKUP_RETENTION = 50  # keep the last N backups, prune older ones

DEAL_STATUSES = [
    "ajanlat_kesz", "megrendelve", "kivitelezes", "reszteljesitve",
    "tig_tervezet", "tig_kikuldve", "tig_alairva", "szamlazasra_kesz",
    "szamla_kikuldve", "fizetve", "lejart", "elavult", "lost",
]
TERMINAL_STATUSES = {"fizetve", "lost", "elavult"}
SIDE_EXITS = {"lost", "elavult"}

# Deal-level allowed transitions for the GENERIC `status` command: current ->
# set of allowed next statuses. Deliberately EXCLUDES every transition that has
# a dedicated, data-capturing subcommand (megrendelolap/tig-tervezet/tig-kikuld/
# tig-alair/szamla-adatlap/szamla-kikuld/szamla-fizetve) -- those must go
# through their own command so the required evidence field (fajl_utvonal,
# kikuldve_at, szamlaszam, ...) can never be silently skipped. The generic
# command is for pure status flips with no required side-record: the
# kivitelezes<->reszteljesitve loop, TIG rollback-on-rejection, and the
# side-exits (lost/elavult, allowed from every non-terminal state).
DEAL_TRANSITIONS = {
    "ajanlat_kesz": set(),          # -> megrendelve ONLY via `megrendelolap`
    "megrendelve": {"kivitelezes"},
    "kivitelezes": {"reszteljesitve"},        # -> tig_tervezet ONLY via `tig-tervezet`
    "reszteljesitve": {"kivitelezes"},        # -> tig_tervezet ONLY via `tig-tervezet`
    "tig_tervezet": {"kivitelezes", "reszteljesitve"},  # visszalepes; -> tig_kikuldve ONLY via `tig-kikuld`
    "tig_kikuldve": {"tig_tervezet"},         # visszalepes ha elutasitva; -> tig_alairva ONLY via `tig-alair`
    "tig_alairva": set(),           # -> szamlazasra_kesz ONLY via `szamla-adatlap`
    "szamlazasra_kesz": set(),      # -> szamla_kikuldve ONLY via `szamla-kikuld`
    "szamla_kikuldve": {"lejart"},  # -> fizetve ONLY via `szamla-fizetve`
    "lejart": set(),                # -> fizetve ONLY via `szamla-fizetve`
}
for _s in list(DEAL_TRANSITIONS):
    if _s not in TERMINAL_STATUSES:
        DEAL_TRANSITIONS[_s] |= SIDE_EXITS
DEAL_TRANSITIONS.setdefault("ajanlat_kesz", set())
DEAL_TRANSITIONS["ajanlat_kesz"] |= SIDE_EXITS


class GateError(Exception):
    pass


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def acquire_lock():
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    fh = open(LOCK_PATH, "w")
    try:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        raise GateError("another nina_deals.py instance holds the lock -- retry shortly")
    return fh


def load():
    if not DEALS_PATH.exists():
        return {"deals": []}
    return json.loads(DEALS_PATH.read_text(encoding="utf-8"))


def backup(data):
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = now_iso().replace(":", "").replace("+00:00", "Z")
    dest = BACKUP_DIR / f"deals-{stamp}.json"
    dest.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    backups = sorted(BACKUP_DIR.glob("deals-*.json"))
    for old in backups[:-BACKUP_RETENTION]:
        old.unlink(missing_ok=True)


def save(data):
    backup(load())
    tmp = DEALS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, DEALS_PATH)


def find_deal(data, deal_id):
    for d in data["deals"]:
        if d["deal_id"] == deal_id:
            return d
    raise GateError(f"ismeretlen deal_id: {deal_id}")


def log_event(deal, event, forras, note=None):
    deal.setdefault("tortenet", []).append({
        "ts": now_iso(), "esemeny": event, "forras": forras,
        **({"note": note} if note else {}),
    })


def require_status(deal, *allowed):
    if deal["statusz"] not in allowed:
        raise GateError(
            f"deal {deal['deal_id']} statusza '{deal['statusz']}', "
            f"ehhez a muvelethez ez kell: {', '.join(allowed)}")


# --- subcommands -------------------------------------------------------
def cmd_create(a):
    data = load()
    if any(d["deal_id"] == a.id for d in data["deals"]):
        raise GateError(f"deal_id mar letezik: {a.id}")
    deal = {
        "deal_id": a.id,
        "ugyfel": a.ugyfel,
        "targy": a.targy,
        "ajanlat": {
            "forras": a.ajanlat_forras, "netto": a.ajanlat_netto,
            "ervenyesseg": a.ajanlat_ervenyesseg, "besanyi_ref": a.besanyi_ref,
        },
        "statusz": "ajanlat_kesz",
        "statusz_datumok": {"ajanlat_kesz": now_iso()},
        "megrendelolap": {"sablon_forras": None, "alairt_at": None, "fajl_utvonal": None},
        "tig": [],
        "kanban_card": a.kanban_card,
        "tortenet": [],
    }
    log_event(deal, "letrehozva", a.forras, a.note)
    data["deals"].append(deal)
    save(data)
    print(f"OK: {a.id} letrehozva, statusz=ajanlat_kesz")


def cmd_status(a):
    data = load()
    deal = find_deal(data, a.id)
    cur = deal["statusz"]
    if cur in TERMINAL_STATUSES:
        raise GateError(f"deal {a.id} lezart allapotban ({cur}), nincs tovabbi atmenet")
    allowed = DEAL_TRANSITIONS.get(cur, set())
    if a.to not in allowed:
        raise GateError(
            f"tiltott atmenet: {cur} -> {a.to}. Engedelyezett innen: {sorted(allowed) or '(nincs)'}. "
            f"(Ha dedikalt parancs letezik ehhez -- megrendelolap/tig-tervezet/tig-kikuld/"
            f"tig-alair/szamla-adatlap/szamla-kikuld/szamla-fizetve -- azt hasznald.)")
    deal["statusz"] = a.to
    deal.setdefault("statusz_datumok", {})[a.to] = now_iso()
    log_event(deal, f"statusz: {cur} -> {a.to}", a.forras, a.note)
    save(data)
    print(f"OK: {a.id} statusz {cur} -> {a.to}")


def cmd_megrendelolap(a):
    data = load()
    deal = find_deal(data, a.id)
    require_status(deal, "ajanlat_kesz")
    deal["megrendelolap"] = {
        "sablon_forras": a.sablon_forras, "alairt_at": a.alairt_at or now_iso(),
        "fajl_utvonal": a.fajl_utvonal,
    }
    deal["statusz"] = "megrendelve"
    deal.setdefault("statusz_datumok", {})["megrendelve"] = now_iso()
    log_event(deal, "megrendelolap rogzitve, statusz -> megrendelve", a.forras, a.note)
    save(data)
    print(f"OK: {a.id} megrendelolap rogzitve, statusz=megrendelve")


def cmd_tig_open(a):
    data = load()
    deal = find_deal(data, a.id)
    require_status(deal, "kivitelezes", "reszteljesitve")
    items = [x.strip() for x in (a.hianylista or "").split(",") if x.strip()]
    deal.setdefault("tig", []).append({
        "szakasz_megnevezes": a.szakasz, "dok_hianylista": items,
        "kelt": None, "kikuldve_at": None, "alairva_at": None, "szamla": None,
    })
    log_event(deal, f"tig-szakasz nyitva: {a.szakasz} (hianylista: {items or 'ures'})", a.forras, a.note)
    save(data)
    print(f"OK: {a.id} uj tig-szakasz '{a.szakasz}' nyitva, hianylista={items}")


def cmd_tig_hianylista(a):
    data = load()
    deal = find_deal(data, a.id)
    if not deal.get("tig"):
        raise GateError(f"deal {a.id}: nincs nyitott tig-szakasz")
    latest = deal["tig"][-1]
    if latest.get("kelt"):
        raise GateError("a legutobbi tig-szakasz mar tervezet-kesz, hianylista tobbe nem modosithato ezen")
    items = [x.strip() for x in (a.items or "").split(",") if x.strip()]
    latest["dok_hianylista"] = items
    log_event(deal, f"tig-szakasz hianylista frissitve: {items or 'ures'}", a.forras, a.note)
    save(data)
    print(f"OK: {a.id} hianylista frissitve: {items or '(ures)'}")


def cmd_tig_tervezet(a):
    data = load()
    deal = find_deal(data, a.id)
    require_status(deal, "kivitelezes", "reszteljesitve")
    if not deal.get("tig") or deal["tig"][-1].get("dok_hianylista"):
        raise GateError("tig-tervezet csak ures hianylistaju, nyitott tig-szakaszra keszithetot")
    deal["tig"][-1]["kelt"] = now_iso()
    deal["statusz"] = "tig_tervezet"
    deal.setdefault("statusz_datumok", {})["tig_tervezet"] = now_iso()
    log_event(deal, "TIG-tervezet keszen (jovahagyasra var)", a.forras, a.note)
    save(data)
    print(f"OK: {a.id} TIG-tervezet keszen, statusz=tig_tervezet")


def cmd_tig_kikuld(a):
    data = load()
    deal = find_deal(data, a.id)
    require_status(deal, "tig_tervezet")
    deal["tig"][-1]["kikuldve_at"] = now_iso()
    deal["statusz"] = "tig_kikuldve"
    deal.setdefault("statusz_datumok", {})["tig_kikuldve"] = now_iso()
    log_event(deal, "TIG kikuldve (eliteai jovahagyas utan)", a.forras, a.note)
    save(data)
    print(f"OK: {a.id} TIG kikuldve, statusz=tig_kikuldve")


def cmd_tig_alair(a):
    data = load()
    deal = find_deal(data, a.id)
    require_status(deal, "tig_kikuldve")
    deal["tig"][-1]["alairva_at"] = now_iso()
    deal["statusz"] = "tig_alairva"
    deal.setdefault("statusz_datumok", {})["tig_alairva"] = now_iso()
    log_event(deal, "TIG alairva visszaerkezett", a.forras, a.note)
    save(data)
    print(f"OK: {a.id} TIG alairva, statusz=tig_alairva")


def cmd_szamla_adatlap(a):
    data = load()
    deal = find_deal(data, a.id)
    require_status(deal, "tig_alairva")
    deal["tig"][-1]["szamla"] = {
        "szam": None, "kelt": None, "fiz_hatarido": a.fiz_hatarido, "fizetve_at": None,
    }
    deal["statusz"] = "szamlazasra_kesz"
    deal.setdefault("statusz_datumok", {})["szamlazasra_kesz"] = now_iso()
    log_event(deal, "szamlazasi adatlap keszen (szamlazz.hu-hoz)", a.forras, a.note)
    save(data)
    print(f"OK: {a.id} szamlazasi adatlap keszen, statusz=szamlazasra_kesz")


def cmd_szamla_kikuld(a):
    data = load()
    deal = find_deal(data, a.id)
    require_status(deal, "szamlazasra_kesz")
    deal["tig"][-1]["szamla"]["szam"] = a.szamlaszam
    deal["tig"][-1]["szamla"]["kelt"] = now_iso()
    deal["statusz"] = "szamla_kikuldve"
    deal.setdefault("statusz_datumok", {})["szamla_kikuldve"] = now_iso()
    log_event(deal, f"szamla kikuldve ({a.szamlaszam})", a.forras, a.note)
    save(data)
    print(f"OK: {a.id} szamla kikuldve, statusz=szamla_kikuldve")


def cmd_szamla_fizetve(a):
    data = load()
    deal = find_deal(data, a.id)
    require_status(deal, "szamla_kikuldve", "lejart")
    deal["tig"][-1]["szamla"]["fizetve_at"] = now_iso()
    deal["statusz"] = "fizetve"
    deal.setdefault("statusz_datumok", {})["fizetve"] = now_iso()
    log_event(deal, "szamla kiegyenlitve", a.forras, a.note)
    save(data)
    print(f"OK: {a.id} szamla fizetve, statusz=fizetve")


def cmd_show(a):
    data = load()
    deal = find_deal(data, a.id)
    print(json.dumps(deal, indent=2, ensure_ascii=False))


def cmd_list(a):
    data = load()
    for d in data["deals"]:
        if a.status and d["statusz"] != a.status:
            continue
        print(f"{d['deal_id']:14s} {d['statusz']:18s} {d.get('ugyfel','')}")


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add_common(p):
        p.add_argument("--id", required=True, help="deal_id")
        p.add_argument("--forras", required=True, help="ki/mi kezdemenyezte (pl. nina, eliteai, laci)")
        p.add_argument("--note", default=None)

    p = sub.add_parser("create", help="uj deal (statusz=ajanlat_kesz)")
    p.add_argument("--id", required=True)
    p.add_argument("--ugyfel", required=True)
    p.add_argument("--targy", required=True)
    p.add_argument("--ajanlat-forras")
    p.add_argument("--ajanlat-netto")
    p.add_argument("--ajanlat-ervenyesseg")
    p.add_argument("--besanyi-ref")
    p.add_argument("--kanban-card", default=None)
    p.add_argument("--forras", required=True)
    p.add_argument("--note", default=None)
    p.set_defaults(func=cmd_create)

    p = sub.add_parser("status", help="deal-szintu statusz-atmenet (gep-validalt)")
    add_common(p)
    p.add_argument("--to", required=True, choices=DEAL_STATUSES)
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("megrendelolap", help="alairt megrendelolap rogzitese -> statusz=megrendelve")
    add_common(p)
    p.add_argument("--sablon-forras")
    p.add_argument("--alairt-at", default=None)
    p.add_argument("--fajl-utvonal", required=True)
    p.set_defaults(func=cmd_megrendelolap)

    p = sub.add_parser("tig-open", help="uj tig-szakasz nyitasa (resz/teljes teljesitesnel)")
    add_common(p)
    p.add_argument("--szakasz", required=True, help="pl. '1. reszteljesites' vagy 'teljes'")
    p.add_argument("--hianylista", default="", help="vesszovel elvalasztott lista")
    p.set_defaults(func=cmd_tig_open)

    p = sub.add_parser("tig-hianylista", help="a legutobbi (nyitott) tig-szakasz hianylistajanak frissitese")
    add_common(p)
    p.add_argument("--items", default="", help="vesszovel elvalasztott lista, ures = nincs hianyzo dok")
    p.set_defaults(func=cmd_tig_hianylista)

    p = sub.add_parser("tig-tervezet", help="TIG-tervezet keszen (csak ures hianylistanal)")
    add_common(p)
    p.set_defaults(func=cmd_tig_tervezet)

    p = sub.add_parser("tig-kikuld", help="TIG kikuldve (eliteai jovahagyas UTAN hivd)")
    add_common(p)
    p.set_defaults(func=cmd_tig_kikuld)

    p = sub.add_parser("tig-alair", help="alairt TIG visszaerkezett")
    add_common(p)
    p.set_defaults(func=cmd_tig_alair)

    p = sub.add_parser("szamla-adatlap", help="szamlazasi adatlap keszen (szamlazz.hu-hoz)")
    add_common(p)
    p.add_argument("--fiz-hatarido", required=True)
    p.set_defaults(func=cmd_szamla_adatlap)

    p = sub.add_parser("szamla-kikuld", help="szamla kikuldve (ember allitotta ki)")
    add_common(p)
    p.add_argument("--szamlaszam", required=True)
    p.set_defaults(func=cmd_szamla_kikuld)

    p = sub.add_parser("szamla-fizetve", help="szamla kiegyenlitve")
    add_common(p)
    p.set_defaults(func=cmd_szamla_fizetve)

    p = sub.add_parser("show", help="egy deal teljes rekordja (JSON)")
    p.add_argument("--id", required=True)
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("list", help="osszes deal, opcionalisan statusz-szuroval")
    p.add_argument("--status", default=None, choices=DEAL_STATUSES)
    p.set_defaults(func=cmd_list)

    return ap


def main(argv=None):
    ap = build_parser()
    a = ap.parse_args(argv)
    is_mutating = a.cmd not in ("show", "list")
    lock = None
    try:
        if is_mutating:
            lock = acquire_lock()
        a.func(a)
    except GateError as e:
        print(f"ELUTASITVA: {e}", file=sys.stderr)
        return 1
    finally:
        if lock is not None:
            lock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
