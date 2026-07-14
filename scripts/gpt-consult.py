#!/usr/bin/env python3
"""
Altalanos GPT-consult (fejlesztesi dontesek keresztellenorzese/otletelese).
Laci direktivaja (2026-07-10): minden fejlesztesi dontesnel GPT-t is bevonni,
DE a GPT-nek latnia kell a NAGY KEPET, kulonben pontatlan az ertekelese.

Ezert ez a helper KOTELEZOEN egy 'context' (big-picture) reszt es egy 'kerdes'
reszt vesz, es osszefuzi egy GPT-promptba (gpt-4.1). A kulcs a bosseges kontextus.

Hasznalat:
  python3 scripts/gpt-consult.py <context_fajl(ok) vesszovel> --ask "<kerdes>" [--role ideation|crosscheck]

A kulcsot store/.openai-key-bol olvassa (sose logolja). Stdlib-only (urllib).
"""
import sys, json, argparse, urllib.request
from pathlib import Path

ROOT = "/home/kapucnis/marveen"
KEYFILE = f"{ROOT}/store/.openai-key"

SYS = {
 "ideation": ("Te egy senior szoftver-architekt es biztonsagi szakerto vagy, aki egy kis "
   "csapat sajat multi-agent ops-platformjahoz (marveen) ad ERTEKELEST es OTLETEKET egy tervhez. "
   "Kapod a NAGY KEPET (a rendszer, a vizio, a jelenlegi allapot) ES egy konkret tervet. "
   "A feladatod: (1) ertekeld a terv helyesseget a KONTEXTUS fenyeben; (2) mutass ra hianyokra/"
   "kockazatokra/edge-case-ekre; (3) adj konkret, megvalosithato javaslatokat. Legy oszinte es "
   "konkret, ne altalanossagokban. Ha valami jo, mondd ki; ha kockazatos, indokold."),
 "crosscheck": ("Te egy senior szoftver-architekt es biztonsagi szakerto vagy, aki egy VEGLEGESITETT "
   "tervet ellenoriz DONTES ELOTT. Kapod a nagy kepet + a vegleges tervet. A feladatod: adversarialis "
   "keresztellenorzes - keresd a hibakat, a rejtett kockazatokat, a hianyzo eseteket, a biztonsagi "
   "reseket. A vegen mondj egy egyertelmu verdiktet: GO / GO-feltetellel / NO-GO, indoklassal."),
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("context", help="context fajl(ok), vesszovel elvalasztva")
    ap.add_argument("--ask", required=True, help="a konkret kerdes/feladat GPT-nek")
    ap.add_argument("--role", default="ideation", choices=["ideation","crosscheck"])
    ap.add_argument("--model", default="gpt-4.1")
    args = ap.parse_args()

    parts = []
    for f in args.context.split(","):
        f = f.strip()
        p = Path(f)
        if not p.is_absolute():
            p = Path(ROOT)/f
        parts.append(f"\n===== KONTEXTUS-FAJL: {p.name} =====\n{p.read_text()}")
    context = "\n".join(parts)

    user = (f"# NAGY KEP (a teljes kontextus, hogy pontos legyen az ertekelesed)\n{context}\n\n"
            f"# A KONKRET KERDES / FELADAT\n{args.ask}\n\n"
            f"Valaszolj strukturaltan, magyarul.")

    key = open(KEYFILE).read().strip()
    body = {"model": args.model,
            "messages": [{"role":"system","content":SYS[args.role]},
                         {"role":"user","content":user}],
            "temperature": 0.3}
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        resp = json.load(r)
    print("=== GPT ("+resp.get("model","?")+", role="+args.role+", tokens="+str(resp.get("usage",{}).get("total_tokens"))+") ===\n")
    print(resp["choices"][0]["message"]["content"])

if __name__ == "__main__":
    main()
