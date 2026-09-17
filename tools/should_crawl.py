#!/usr/bin/env python3
"""
Decide whether a full crawl is worth running right now.

The index is checked several times a day, but a full crawl is ~5,400 page
requests plus a HEAD for every document, and aa.org usually changes nothing
between checks. Running that four times a day would put a lot of pointless
load on a nonprofit's website.

So each check first asks the sitemap what changed, which costs three requests.
The sitemap *index* is useless for this -- Drupal regenerates it hourly
regardless -- but each URL entry carries a real content timestamp, so a
fingerprint over every (loc, lastmod) pair tells us whether anything was
published or edited.

A fingerprint alone is not quite enough: aa.org can replace a PDF without
touching the page that links it. So a full crawl also runs whenever the last
one is older than --max-age hours, whatever the sitemap says.

Writes `should_crawl=true|false` to $GITHUB_OUTPUT when run in Actions, and
exits 0 either way. `--commit` records the fingerprint after a crawl
succeeded, so a skipped or failed run does not lose the signal.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(ROOT, "data", "crawl_state.json")
SITEMAP_INDEX = "https://www.aa.org/sitemap.xml"
UA = "SimplifyAA-Indexer/1.0 (+https://github.com/MKP715/SimplifyAA) change-check"


def fetch(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    resp = urllib.request.urlopen(req, timeout=60)
    raw = resp.read()
    if resp.headers.get("Content-Encoding") == "gzip":
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", errors="replace")


def sitemap_fingerprint():
    """sha256 over every (url, lastmod) pair the sitemap advertises."""
    index = fetch(SITEMAP_INDEX)
    subs = [u for u in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", index) if "sitemap" in u]
    if not subs:
        subs = [SITEMAP_INDEX]

    entries = []
    for sub in subs:
        body = fetch(sub)
        # Pair each <loc> with the <lastmod> inside the same <url> block.
        for block in re.findall(r"<url>(.*?)</url>", body, re.S):
            loc = re.search(r"<loc>\s*([^<\s]+)\s*</loc>", block)
            mod = re.search(r"<lastmod>\s*([^<\s]+)\s*</lastmod>", block)
            if loc:
                entries.append(loc.group(1) + "\t" + (mod.group(1) if mod else ""))

    entries.sort()
    digest = hashlib.sha256("\n".join(entries).encode("utf-8")).hexdigest()
    return digest, len(entries)


def load_state():
    if not os.path.exists(STATE_PATH):
        return {}
    try:
        with open(STATE_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def hours_since(iso):
    if not iso:
        return None
    try:
        then = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - then).total_seconds() / 3600.0


def emit(should, reason, fingerprint, entries):
    # The reason is interpolated into a shell echo in the workflow summary, and
    # can contain an exception message, so keep it to one harmless line.
    reason = re.sub(r"[\r\n\"'`$\\]", " ", str(reason))
    reason = re.sub(r"\s+", " ", reason).strip()[:200]
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as fh:
            fh.write("should_crawl=%s\n" % ("true" if should else "false"))
            fh.write("reason=%s\n" % reason)
    print("should_crawl=%s" % ("true" if should else "false"))
    print("reason: %s" % reason)
    if fingerprint:
        print("sitemap: %d urls, fingerprint %s" % (entries, fingerprint[:16]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-age", type=float, default=24.0,
                    help="force a crawl if the last one is older than this many hours")
    ap.add_argument("--force", action="store_true", help="always say yes")
    ap.add_argument("--commit", action="store_true",
                    help="record the current fingerprint (run after a successful crawl)")
    args = ap.parse_args()

    state = load_state()

    try:
        fingerprint, entries = sitemap_fingerprint()
    except Exception as e:
        if args.commit:
            sys.stderr.write("WARNING: could not fingerprint the sitemap (%s)\n" % e)
            return 0
        # Never let a failed check silently stop the index from updating.
        emit(True, "sitemap unavailable (%s) - crawling to be safe" % e, "", 0)
        return 0

    if args.commit:
        state.update({
            "sitemap_fingerprint": fingerprint,
            "sitemap_urls": entries,
            "last_full_crawl_utc": datetime.now(timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%SZ"),
        })
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2)
        print("recorded fingerprint %s (%d urls)" % (fingerprint[:16], entries))
        return 0

    if args.force:
        emit(True, "forced", fingerprint, entries)
        return 0

    previous = state.get("sitemap_fingerprint")
    if not previous:
        emit(True, "no previous fingerprint recorded", fingerprint, entries)
        return 0

    if previous != fingerprint:
        emit(True, "aa.org changed since the last crawl", fingerprint, entries)
        return 0

    age = hours_since(state.get("last_full_crawl_utc"))
    if age is None:
        emit(True, "last crawl time unknown", fingerprint, entries)
        return 0
    if age >= args.max_age:
        emit(True, "no sitemap change, but the last crawl was %.1fh ago "
                   "(a PDF can be replaced without the page changing)" % age,
             fingerprint, entries)
        return 0

    emit(False, "sitemap unchanged and last crawl was %.1fh ago - nothing to do" % age,
         fingerprint, entries)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
