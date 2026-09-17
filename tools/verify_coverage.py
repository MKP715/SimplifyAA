#!/usr/bin/env python3
"""
Independently verify that the index really did catch every PDF on aa.org.

The crawler could always be wrong in a way its own logs would not reveal, so
this re-fetches pages straight from aa.org and checks that every PDF link on
them is accounted for -- either indexed, or recorded as a dead link.

Two samples are used, because they fail differently:
  * a random sample of sitemap pages, which catches a systematic gap;
  * the paginated hub pages, which are where documents hide.

Usage:
  python tools/verify_coverage.py            # 300 random pages + all pagers
  python tools/verify_coverage.py --sample 600
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import random
import re
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
UA = "SimplifyAA-Indexer/1.0 (+https://github.com/MKP715/SimplifyAA) coverage-check"

SITE = "https://www.aa.org"
PDF_HOSTS = {"www.aa.org", "aa.org", "aaws.widen.net", "embed.widencdn.net",
             "aaws.widencollective.com", "aa.widen.net",
             "www.aagrapevine.org", "aagrapevine.org"}
HOST_REWRITE = {"alcanonymous1.prod.acquia-sites.com": "www.aa.org"}

# Hub pages whose later pages carry documents found nowhere else.
PAGER_BASES = [
    "/news-and-announcements", "/es/news-and-announcements", "/fr/news-and-announcements",
    "/newsletters", "/es/newsletters", "/fr/newsletters",
    "/resources/literature", "/",
]
PAGER_DEPTH = 16


def get(url):
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
        resp = urllib.request.urlopen(req, timeout=40)
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return ""


def canon(url):
    url = url.strip().replace(" ", "%20")
    p = urllib.parse.urlsplit(url)
    host = HOST_REWRITE.get(p.netloc.lower(), p.netloc.lower())
    keep = [(k, v) for k, v in urllib.parse.parse_qsl(p.query)
            if k.lower() not in ("v", "t", "cache", "cb", "download", "_ga",
                                 "utm_source", "utm_medium", "utm_campaign")]
    return urllib.parse.urlunsplit(
        ("https", host, p.path, urllib.parse.urlencode(keep), ""))


def pdf_links_on(page_url, html):
    found = set()
    pattern = re.compile(
        r'(?:href|src|data)="([^"]+?\.pdf(?:\?[^"]*)?)"', re.I)
    for m in pattern.finditer(html):
        full = urllib.parse.urljoin(page_url, m.group(1).replace(" ", "%20"))
        if urllib.parse.urlsplit(full).netloc.lower() in PDF_HOSTS or \
                urllib.parse.urlsplit(full).netloc.lower() in HOST_REWRITE:
            found.add(canon(full))
    return found


def sitemap_urls():
    urls = set()
    body = get(SITE + "/sitemap.xml")
    pages = [u for u in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", body) if "sitemap" in u]
    for sm in pages or [SITE + "/sitemap.xml"]:
        sub = get(sm)
        for loc in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", sub):
            urls.add(loc)
    return sorted(urls)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=300)
    ap.add_argument("--workers", type=int, default=10)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    with open(os.path.join(DATA, "pdfs.csv"), encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    indexed = {r["url"] for r in rows}
    with open(os.path.join(DATA, "broken_links.csv"), encoding="utf-8") as fh:
        broken = {r["url"] for r in csv.DictReader(fh)}

    # A link also counts as covered if it resolves to something indexed, since
    # aa.org's legacy URLs redirect to the Widen copy.
    finals = {}
    cache = os.path.join(ROOT, ".cache", "crawl_raw.json")
    if os.path.exists(cache):
        with open(cache, encoding="utf-8") as fh:
            heads = json.load(fh).get("heads", {})
        finals = {u.lower(): ((i or {}).get("final_url") or u).lower()
                  for u, i in heads.items()}
    indexed_finals = {finals.get(u.lower(), u.lower()) for u in indexed}

    def covered(u):
        if u in indexed or u in broken:
            return True
        f = finals.get(u.lower())
        return bool(f and f in indexed_finals)

    print("Index: %d live PDFs, %d recorded dead links" % (len(indexed), len(broken)))

    targets = []
    all_urls = sitemap_urls()
    print("Sitemap: %d pages" % len(all_urls))
    if len(all_urls) < 50:
        print("ERROR: sitemap unavailable; cannot verify.")
        return 1
    random.seed(args.seed)
    targets += random.sample(all_urls, min(args.sample, len(all_urls)))
    targets += [SITE + b + ("?page=%d" % p if p else "")
                for b in PAGER_BASES for p in range(PAGER_DEPTH)]

    seen_pages = 0
    found = set()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for url, html in zip(targets, pool.map(get, targets)):
            if not html:
                continue
            seen_pages += 1
            found |= pdf_links_on(url, html)

    missing = sorted(u for u in found if not covered(u))
    print("Pages re-fetched from aa.org : %d" % seen_pages)
    print("Distinct PDF links on them   : %d" % len(found))
    print("Covered by the index         : %d" % (len(found) - len(missing)))
    print("MISSING                      : %d" % len(missing))
    for u in missing[:25]:
        print("   ", u[:130])
    if missing:
        print("\nFAIL: the index is missing links that aa.org publishes.")
        return 1
    print("\nPASS: every PDF link on those pages is accounted for.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
