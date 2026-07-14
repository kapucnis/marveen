#!/usr/bin/env python3
"""
Arazo torzs keresztellenorzo (second-opinion) az OpenAI API-val.

Kiszedi a TORZS_ANYAG besorolasi adatait + a torzs-referenciakat (ervenyes
alrendszer/kategoria parok, munkadij-tipusok, install-profilok), elkuldi a
GPT-nek a mi triage-szempontjainkkal, es strukturalt JSON findings-listat kap
vissza. A kimenetet timestamp-elt fajlba irja, hogy EliteAI szembeallithassa
a sajat reviewjaval.

Hasznalat:
  python3 scripts/arazo-crosscheck.py [xlsx_path] [--model gpt-4.1]

A kulcsot a store/.openai-key fajlbol olvassa (sose logolja). Stdlib-only
(urllib), nincs kulso fuggoseg.
"""
import sys, os, re, json, time, zipfile, urllib.request
from xml.etree import ElementTree as ET

ROOT = "/home/kapucnis/marveen"
KEYFILE = f"{ROOT}/store/.openai-key"
DEFAULT_XLSX = f"{ROOT}/store/arazo-pipeline/Biztonsagtechnikai_arazo_v2_8_tiszta.xlsx"
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def colnum(ref):
    m = re.match(r"([A-Z]+)", ref)
    s = 0
    for c in m.group(1):
        s = s * 26 + (ord(c) - 64)
    return s - 1


def cellval(c):
    v = c.find(NS + "v")
    isv = c.find(NS + "is")
    if isv is not None:
        return "".join((x.text or "") for x in isv.iter(NS + "t"))
    return v.text if v is not None else ""


def sheet_names(z):
    wb = z.read("xl/workbook.xml").decode("utf-8", "replace")
    return re.findall(r'name="([^"]+)"', wb)


def read_sheet(z, idx):
    root = ET.fromstring(z.read(f"xl/worksheets/sheet{idx}.xml"))
    rows = {}
    for r in root.iter(NS + "row"):
        rn = int(r.get("r"))
        cells = {}
        for c in r.findall(NS + "c"):
            cells[colnum(c.get("r"))] = cellval(c)
        rows[rn] = cells
    return rows


def sheet_as_records(z, names, name):
    idx = names.index(name) + 1
    rows = read_sheet(z, idx)
    if not rows:
        return []
    # Header = the WIDEST row (most non-empty cells) among the first rows.
    # A leading title/description row has 1 cell; the real header spans many,
    # so max-non-empty robustly skips titles like "Belso torzs pillanatkep...".
    def nonempty(rn):
        return sum(1 for i in range(40) if (rows[rn].get(i) or "").strip())
    candidates = sorted(rows)[:10]
    hdr_rn = max(candidates, key=lambda rn: (nonempty(rn), -rn))
    hdr = rows[hdr_rn]
    ncol = max(hdr) + 1 if hdr else 0
    heads = [(hdr.get(i) or "").strip() for i in range(ncol)]
    recs = []
    for rn in sorted(rows):
        if rn <= hdr_rn:
            continue
        row = rows[rn]
        rec = {heads[i]: (row.get(i) or "").strip() for i in range(ncol) if heads[i]}
        if any(rec.values()):
            rec["_xlrow"] = rn
            recs.append(rec)
    return recs


def build_prompt(anyag, pairs, mdij, install):
    valid_pairs = sorted({(p.get("Alrendszer", ""), p.get("Kategória", "")) for p in pairs})
    mdij_types = sorted({m.get("Munkadíj típus", m.get("Munkadij tipus", "")) for m in mdij if any(m.values())})
    install_profiles = sorted({i.get("Profil név", i.get("Installációs profil", "")) for i in install if any(i.values())})

    lines = []
    for r in anyag:
        lines.append("\t".join([
            str(r.get("_xlrow", "")),
            r.get("Cikkszám", ""),
            (r.get("Megnevezés", "") or "")[:90],
            r.get("Alrendszer", ""),
            r.get("Kategória", ""),
            r.get("Alap munkadíj típus", ""),
            r.get("Alap installációs profil", ""),
        ]))
    table = "\n".join(lines)

    sys_prompt = (
        "Te egy magyar biztonsagtechnikai (CCTV, beleptetes, behatolasjelzes, kaputelefon, "
        "halozati infrastruktura) arazasi szakerto vagy, aki egy tetel-torzs (master catalog) "
        "besorolasi konzisztenciajat ellenorzi. NEM a beszerzesi arat nezed, hanem a "
        "STRUKTURAT: alrendszer/kategoria helyesseg, munkadij-tipus es install-profil illeszkedes."
    )
    user_prompt = f"""Ellenorizd az alabbi arazo torzs (TORZS_ANYAG) besorolasait. Minden sor:
xlrow / cikkszam / megnevezes / alrendszer / kategoria / munkadij-tipus / install-profil.

ERVENYES (alrendszer, kategoria) PAROK:
{chr(10).join(f'- {a} / {k}' for a,k in valid_pairs)}

ERVENYES MUNKADIJ-TIPUSOK:
{chr(10).join(f'- {t}' for t in mdij_types if t)}

ERVENYES INSTALL-PROFILOK:
{chr(10).join(f'- {p}' for p in install_profiles if p)}

TRIAGE-SZEMPONTOK (ezekre koncentralj):
1. Szoftver/licenc tetel fizikai szerelesi munkadijjal vagy hardver-kategoriaval (pl. VMS/ANPR licenc "kamera felszereles" munkadijjal).
2. Aktiv halozati eszkoz (PoE switch, NVR, szerver, monitor, tapegyseg, UPS, akku) rossz kategoriaban (pl. "Kamera") vagy kamera-install-profillal (KAM-xx).
3. Munkadij-tipus ami nyilvanvaloan nem illik a tetelhez (pl. NVR "nyomvonal csovezes" munkadijjal).
4. Nyomvonal/vedocso/kabel tetel "Egyeb" alrendszerben.
5. Kaputelefon vs belepteto olvaso kettosseg.
6. Kompozit/kit tetelek (tobb funkcio egy cikkszamban) - ezt csak JELEZD, ne eroltess egyertelmu besorolast.

CSAK VALODI problemat jelezz, ne talalj ki hibat. Ha egy sor rendben van, ne szerepeljen.
Valaszolj KIZAROLAG egy JSON objektummal, ilyen semaval:
{{"findings": [{{"xlrow": <int>, "cikkszam": "<str>", "suly": "KRITIKUS|MAGAS|KOZEPES", "problema": "<rovid>", "javaslat": "<rovid, konkret>"}}]}}

ADAT ({len(anyag)} sor):
{table}"""
    return sys_prompt, user_prompt


def call_openai(key, model, sys_prompt, user_prompt):
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.load(resp)


def main():
    args = [a for a in sys.argv[1:]]
    model = "gpt-4.1"
    if "--model" in args:
        i = args.index("--model")
        model = args[i + 1]
        del args[i:i + 2]
    xlsx = args[0] if args else DEFAULT_XLSX

    key = open(KEYFILE).read().strip()
    z = zipfile.ZipFile(xlsx)
    names = sheet_names(z)
    anyag = sheet_as_records(z, names, "TORZS_ANYAG")
    pairs = sheet_as_records(z, names, "TORZS_ALR_KAT")
    mdij = sheet_as_records(z, names, "TORZS_MUNKADIJ")
    install = sheet_as_records(z, names, "TORZS_INSTALL")

    sys_p, user_p = build_prompt(anyag, pairs, mdij, install)
    print(f"[crosscheck] xlsx={os.path.basename(xlsx)} sorok={len(anyag)} model={model}", file=sys.stderr)
    t0 = time.time()
    resp = call_openai(key, model, sys_p, user_p)
    dt = round(time.time() - t0, 1)

    content = resp["choices"][0]["message"]["content"]
    usage = resp.get("usage", {})
    try:
        findings = json.loads(content).get("findings", [])
    except Exception:
        findings = []
        print("[crosscheck] JSON parse-fail, nyers valasz mentve", file=sys.stderr)

    out = {
        "generated_at": int(time.time()),
        "model": resp.get("model"),
        "source_file": xlsx,
        "row_count": len(anyag),
        "elapsed_s": dt,
        "usage": usage,
        "findings": findings,
        "raw_if_unparsed": None if findings else content,
    }
    return out


if __name__ == "__main__":
    result = main()
    print(json.dumps(result, ensure_ascii=False, indent=2))
