#!/usr/bin/env python3
"""
Build the service-kit index: which documents each A.A. service kit contains.

A kit ("Contents of Treatment Committee Kit List", F-167) is a one-page list
naming every pamphlet, workbook, guideline and form that ships in the kit. The
contents are only stated inside that PDF, so this tool reads each kit list and
extracts the A.A. item numbers it names -- catalog identifiers such as "P-26"
or "M-40I", nothing else. Those numbers are then matched against the document
index, which is what lets the site show a kit as a set of working links.

Candidates are found by title, then confirmed by extraction: a document counts
as a kit list only if it names several other items. That way a new kit on
aa.org is picked up without editing this file.

Outputs:
  data/kits.csv        one row per (kit, language, item), in listed order
  data/kits_meta.json  per-kit summary used by the front-end
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import urllib.request
from collections import Counter, OrderedDict, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from pypdf import PdfReader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
UA = "SimplifyAA-Indexer/1.0 (+https://github.com/MKP715/SimplifyAA) kit-contents"

# Documents whose title suggests they enumerate a kit or resource list.
CANDIDATE_RE = re.compile(
    r"\bkit\b|\bkits\b|pochette|paquete|toolkit"
    r"|resource[-_ ]list|lista[-_ ]de[-_ ]recursos|liste[-_ ]de[-_ ]ressources"
    r"|contents[-_ ]of|contenido[-_ ]del|contenido[-_ ]de|contenu[-_ ]de|contenu[-_ ]du"
    r"|group[-_ ]handbook|manual[-_ ]del[-_ ]grupo|manuel[-_ ]de[-_ ]groupe",
    re.I,
)

# Never a kit list, however the title reads.
EXCLUDE_RE = re.compile(
    r"bigbook|big[-_ ]book|[_\-]tt[_\-]|twelveandtwelve|livingsober"
    r"|box[-_ ]?459|markings|highlights|faits[-_ ]saillants"
    r"|announcement|anuncio|annonce|notice|press[-_ ]release"
    r"|welcome[-_ ]letter|carta[-_ ]al[-_ ]grupo|lettre[-_ ]de[-_ ]bienvenue"
    r"|survey|encuesta|sondage|catalog|order[-_ ]form",
    re.I,
)

# An A.A. item number as printed inside the kit lists.
CODE_IN_TEXT_RE = re.compile(
    r"\b(SMFS|SMFF|SMF|SMG|FMG|SM|FM|MG|BM|AV|CF|FL|LIM|SF|FF|SP|FP|SB|FB|P|F|M|B)"
    r"[\-‐‑‒–—\s]?(\d{1,3})([A-Z]?)\b"
)

# Language-coded prefixes fold back to one base number (see crawl_aa_pdfs.py).
CODE_LANG_PREFIX = {
    "SF": "F", "FF": "F", "SP": "P", "FP": "P", "SMFS": "SMF", "SMFF": "SMF",
    "SMG": "MG", "FMG": "MG", "SB": "B", "FB": "B", "SM": "M", "FM": "M",
}

MIN_ITEMS = 5           # below this, it is not a kit list
MAX_PAGES = 12          # kit lists are 1-3 pages; a book is not a kit


def base_code(prefix: str, number: str, suffix: str = "") -> str:
    prefix = prefix.upper()
    return CODE_LANG_PREFIX.get(prefix, prefix) + "-" + number + suffix.upper()


def fetch(url: str) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        return urllib.request.urlopen(req, timeout=90).read()
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("  ! could not fetch %s (%s)\n" % (url[:90], e))
        return None


def codes_in_pdf(data: bytes, self_code: str):
    """Item numbers named in a kit list, in the order they appear."""
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("  ! unreadable PDF (%s)\n" % e)
        return None, 0
    pages = len(reader.pages)
    if pages > MAX_PAGES:
        return [], pages
    text = []
    for page in reader.pages:
        try:
            text.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001
            continue
    blob = "\n".join(text)
    # Join numbers split across a line break ("P-\n26").
    blob = re.sub(r"([A-Za-z]{1,4})[\-–]\s*\n\s*(\d)", r"\1-\2", blob)

    ordered = OrderedDict()
    for m in CODE_IN_TEXT_RE.finditer(blob.upper()):
        code = base_code(m.group(1), m.group(2), m.group(3))
        if code == self_code:
            continue  # the list names itself
        ordered.setdefault(code, len(ordered))
    return list(ordered), pages


def clean_kit_name(title: str) -> str:
    """'Contents of Treatment Committee Kit List' -> 'Treatment Committee Kit'."""
    t = re.sub(r"^\s*contents?\s+of\s+(the\s+)?", "", title, flags=re.I)
    t = re.sub(r"^\s*contenido\s+del?\s+(paquete\s+de\s+)?", "", t, flags=re.I)
    t = re.sub(r"^\s*contenu\s+d[eu]\s+(la\s+)?(pochette\s+d[eu]\s*l?'?)?", "", t, flags=re.I)
    t = re.sub(r"\s+list\s*$", "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" -–:")
    return t[:1].upper() + t[1:] if t else title


def main():
    ap = argparse.ArgumentParser(description="Index the contents of A.A. service kits")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--min-items", type=int, default=MIN_ITEMS)
    args = ap.parse_args()

    csv_path = os.path.join(DATA_DIR, "pdfs.csv")
    with open(csv_path, encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        sys.stderr.write("ERROR: data/pdfs.csv is empty; run the crawler first.\n")
        return 1

    by_base = defaultdict(list)
    for r in rows:
        if r["base_code"]:
            by_base[r["base_code"]].append(r)

    # --- candidate kit lists, grouped so each kit is fetched once per language --
    candidates = [
        r for r in rows
        if CANDIDATE_RE.search(r["title"] + " " + r["filename"])
        and not EXCLUDE_RE.search(r["title"] + " " + r["filename"])
    ]
    # Group by base code; kits without an item number (the G.S.R. and press kits)
    # are grouped by their filename with the language marker removed.
    def group_key(r):
        if r["base_code"]:
            return r["base_code"]
        stem = re.sub(r"\.pdf$", "", r["filename"], flags=re.I).lower()
        stem = re.sub(r"(^|[_\-])(en|sp|es|fr)([_\-]|$)", "_", stem)
        stem = re.sub(r"[^a-z0-9]+", "", stem)
        return "stem:" + stem

    grouped = defaultdict(list)
    for r in candidates:
        grouped[group_key(r)].append(r)
    sys.stderr.write("Candidate kit lists: %d groups (%d files)\n"
                     % (len(grouped), len(candidates)))

    # --- read each candidate -------------------------------------------------
    jobs = [(key, r) for key, rs in grouped.items() for r in rs]

    def work(job):
        key, r = job
        data = fetch(r["url"])
        if not data:
            return key, r, None, 0
        codes, pages = codes_in_pdf(data, r["base_code"] or "")
        return key, r, codes, pages

    results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, out in enumerate(pool.map(work, jobs), 1):
            results.append(out)
            sys.stderr.write("\r  read %d/%d" % (i, len(jobs)))
            sys.stderr.flush()
    sys.stderr.write("\n")

    # --- keep only real kit lists -------------------------------------------
    kits = {}
    rejected = []
    for key, r, codes, pages in results:
        if codes is None:
            continue
        if len(codes) < args.min_items:
            rejected.append((r["item_code"] or r["filename"], len(codes)))
            continue
        kit = kits.setdefault(key, {"key": key, "editions": {}, "name": "",
                                    "category": r["category"], "section": r["section"]})
        kit["editions"][r["language"]] = {
            "item_code": r["item_code"], "url": r["url"], "title": r["title"],
            "pages": pages, "items": codes,
        }

    # Name each kit from its English edition where there is one.
    for kit in kits.values():
        ed = kit["editions"].get("English") or next(iter(kit["editions"].values()))
        kit["name"] = clean_kit_name(ed["title"])
        kit["code"] = (ed["item_code"] or "").split("-")
        kit["base_code"] = (kit["key"] if not kit["key"].startswith("stem:") else "")

    sys.stderr.write("Confirmed kits: %d (rejected %d candidates)\n"
                     % (len(kits), len(rejected)))
    for name, n in sorted(rejected)[:12]:
        sys.stderr.write("  - not a kit list: %s (%d items)\n" % (name[:60], n))

    if not kits:
        sys.stderr.write("ERROR: no kits confirmed; refusing to overwrite.\n")
        return 1

    # --- write kits.csv -----------------------------------------------------
    os.makedirs(DATA_DIR, exist_ok=True)
    fields = ["kit_key", "kit_name", "kit_base_code", "kit_language", "kit_item_code",
              "kit_url", "item_order", "item_code", "in_index"]
    out_rows = []
    for key in sorted(kits):
        kit = kits[key]
        for lang in ("English", "Spanish", "French"):
            ed = kit["editions"].get(lang)
            if not ed:
                continue
            for order, code in enumerate(ed["items"], 1):
                out_rows.append({
                    "kit_key": key,
                    "kit_name": kit["name"],
                    "kit_base_code": kit["base_code"],
                    "kit_language": lang,
                    "kit_item_code": ed["item_code"],
                    "kit_url": ed["url"],
                    "item_order": order,
                    "item_code": code,
                    "in_index": "yes" if code in by_base else "no",
                })
    with open(os.path.join(DATA_DIR, "kits.csv"), "w", newline="",
              encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=fields, lineterminator="\n")
        w.writeheader()
        w.writerows(out_rows)

    # --- summary ------------------------------------------------------------
    summary = []
    for key in sorted(kits, key=lambda k: kits[k]["name"]):
        kit = kits[key]
        eng = kit["editions"].get("English") or next(iter(kit["editions"].values()))
        items = eng["items"]
        found = [c for c in items if c in by_base]
        summary.append({
            "key": key,
            "name": kit["name"],
            "base_code": kit["base_code"],
            "category": kit["category"],
            "languages": sorted(kit["editions"]),
            "items": len(items),
            "items_in_index": len(found),
            "workbooks": [c for c in items if c.startswith("M-") and c.endswith("I")],
        })

    meta = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "kits": len(kits),
        "rows": len(out_rows),
        "total_items": sum(s["items"] for s in summary),
        "coverage": sum(s["items_in_index"] for s in summary),
        "kit_list": summary,
    }
    with open(os.path.join(DATA_DIR, "kits_meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)

    sys.stderr.write("\nWrote data/kits.csv (%d rows)\n" % len(out_rows))
    for s in summary:
        sys.stderr.write("  %-46s %-8s %2d items, %2d indexed, langs %s\n"
                         % (s["name"][:46], s["base_code"] or "-", s["items"],
                            s["items_in_index"], ",".join(l[:2] for l in s["languages"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
