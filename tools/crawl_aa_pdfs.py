#!/usr/bin/env python3
"""
Crawl www.aa.org and build a metadata index of every direct PDF link it publishes.

Only link metadata is collected (URL, link text, source page, file size,
last-modified). No PDF content is downloaded or redistributed -- every entry in
the index points back to the official file on aa.org / aaws.widen.net.

Outputs:
  data/pdfs.csv        one row per unique PDF
  data/meta.json       run statistics consumed by the front-end
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from bs4 import BeautifulSoup

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")

SITE = "https://www.aa.org"
SITEMAP_INDEX = SITE + "/sitemap.xml"

# Hosts that serve documents aa.org links to.
ALLOWED_PDF_HOSTS = {
    "www.aa.org",
    "aa.org",
    "aaws.widen.net",
    "aaws.widencollective.com",
    "embed.widencdn.net",
    "aa.widen.net",
    # A.A. Grapevine is a separate corporation, but aa.org links a handful of
    # its PDFs (La Vina notices and similar) and they are live files members
    # are being pointed at, so they belong in the index.
    "www.aagrapevine.org",
    "aagrapevine.org",
}

# aa.org sometimes leaks its Acquia origin hostname into links. Those are the
# same site, so fold them onto the canonical host; that way they get verified
# like any other link instead of being quietly skipped.
HOST_REWRITE = {
    "alcanonymous1.prod.acquia-sites.com": "www.aa.org",
    "alcanonymous1.prod.acquia-sites.com.": "www.aa.org",
}
# Hosts we crawl HTML from.
CRAWL_HOSTS = {"www.aa.org", "aa.org"}

UA = "SimplifyAA-Indexer/1.0 (+https://github.com/MKP715/SimplifyAA) link-metadata-only"

# Deepest "?page=N" we will follow on a listing page.
MAX_PAGER = 100

SKIP_PATH_RE = re.compile(
    r"^/(admin|user|search|comment|filter|node/add|media/oembed|core|profiles"
    r"|modules|themes|sites/default/files/(css|js))(/|$)",
    re.I,
)
ASSET_EXT_RE = re.compile(
    r"\.(jpe?g|png|gif|svg|webp|ico|css|js|mp4|m4v|mov|mp3|wav|zip|docx?|xlsx?|pptx?|eps|ai)$",
    re.I,
)
PDF_RE = re.compile(r"\.pdf($|[?#])", re.I)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class Fetcher:
    def __init__(self, delay=0.0, timeout=30, retries=3):
        self.delay = delay
        self.timeout = timeout
        self.retries = retries
        self._lock = threading.Lock()
        self.stats = defaultdict(int)

    def _bump(self, key):
        with self._lock:
            self.stats[key] += 1

    def open(self, url, method="GET", extra_headers=None):
        last = None
        for attempt in range(self.retries):
            try:
                req = urllib.request.Request(url, method=method)
                req.add_header("User-Agent", UA)
                req.add_header("Accept-Encoding", "gzip")
                req.add_header("Accept", "*/*")
                for k, v in (extra_headers or {}).items():
                    req.add_header(k, v)
                resp = urllib.request.urlopen(req, timeout=self.timeout)
                self._bump("http_ok")
                if self.delay:
                    time.sleep(self.delay)
                return resp
            except urllib.error.HTTPError as e:
                last = e
                if e.code in (403, 404, 410):
                    self._bump("http_" + str(e.code))
                    return None
                time.sleep(1.0 * (attempt + 1))
            except Exception as e:
                last = e
                time.sleep(1.0 * (attempt + 1))
        self._bump("http_fail")
        if os.environ.get("CRAWL_DEBUG"):
            sys.stderr.write("  ! fetch failed %s: %s\n" % (url, last))
        return None

    def text(self, url):
        resp = self.open(url)
        if resp is None:
            return None, None
        try:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                try:
                    raw = gzip.decompress(raw)
                except Exception:
                    pass
            ctype = resp.headers.get("Content-Type", "")
            final = resp.geturl()
        finally:
            resp.close()
        if "html" not in ctype and "xml" not in ctype:
            return None, final
        return raw.decode("utf-8", errors="replace"), final

    def head(self, url):
        """Return dict of file metadata, or None if unreachable."""
        resp = self.open(url, method="HEAD")
        if resp is None:
            resp = self.open(url, method="GET", extra_headers={"Range": "bytes=0-0"})
        if resp is None:
            return None
        try:
            h = resp.headers
            length = h.get("Content-Length") or ""
            crange = h.get("Content-Range") or ""
            if crange:
                m = re.search(r"/(\d+)\s*$", crange)
                if m:
                    length = m.group(1)
            return {
                "final_url": resp.geturl(),
                "status": getattr(resp, "status", 200),
                "content_type": h.get("Content-Type", ""),
                "bytes": int(length) if str(length).isdigit() else 0,
                "last_modified": h.get("Last-Modified", ""),
            }
        finally:
            resp.close()


# --------------------------------------------------------------------------- #
# URL helpers
# --------------------------------------------------------------------------- #
def normalize(url, base):
    if not url:
        return None
    url = url.strip().replace("\n", "").replace("\t", "").replace(" ", "%20")
    low = url.lower()
    if low.startswith(("mailto:", "tel:", "javascript:", "data:", "#")):
        return None
    absolute = urllib.parse.urljoin(base, url)
    p = urllib.parse.urlsplit(absolute)
    if p.scheme not in ("http", "https"):
        return None
    host = p.netloc.lower()
    host = HOST_REWRITE.get(host, host)
    return urllib.parse.urlunsplit(("https", host, p.path, p.query, ""))


def crawlable(url):
    p = urllib.parse.urlsplit(url)
    if p.netloc not in CRAWL_HOSTS:
        return False
    if SKIP_PATH_RE.match(p.path) or ASSET_EXT_RE.search(p.path):
        return False
    if PDF_RE.search(p.path):
        return False
    if p.query:
        # Listing pages really do paginate, and later pages carry documents that
        # appear nowhere else, so "?page=N" must be followed. Only pager links
        # actually present in the HTML get queued, which bounds this naturally;
        # the cap is a backstop against a runaway pager.
        params = dict(urllib.parse.parse_qsl(p.query))
        if set(params) - {"page"}:
            return False  # facets and sorts re-slice the same documents
        page = params.get("page", "0")
        if not page.isdigit() or int(page) > MAX_PAGER:
            return False
    return True


# Every PDF host seen on the site, including ones not in the allowlist, so a
# new file host cannot be skipped silently. Reported at the end of a run.
SEEN_PDF_HOSTS = Counter()
SKIPPED_PDF_SAMPLES = {}


def is_pdf_link(url):
    p = urllib.parse.urlsplit(url)
    if not (PDF_RE.search(p.path) or PDF_RE.search(p.query or "")):
        return False
    SEEN_PDF_HOSTS[p.netloc] += 1
    if p.netloc not in ALLOWED_PDF_HOSTS:
        SKIPPED_PDF_SAMPLES.setdefault(p.netloc, url)
        return False
    return True


def canonical_pdf(url):
    """Strip cache-busting tokens so one file dedupes to one row."""
    p = urllib.parse.urlsplit(url)
    keep = [
        (k, v)
        for k, v in urllib.parse.parse_qsl(p.query)
        if k.lower() not in ("v", "t", "cache", "cb", "download", "_ga", "utm_source",
                             "utm_medium", "utm_campaign")
    ]
    return urllib.parse.urlunsplit(
        ("https", p.netloc, p.path, urllib.parse.urlencode(keep), "")
    )


LANG_NAMES = {"es": "Spanish", "fr": "French", "en": "English"}


def language_of(url, *hints, filename="", code_lang=""):
    """Decide language from the strongest available signal.

    Order: the document's own item code (SF-13 is unambiguously Spanish), then
    a language prefix on the filename, then URL locale markers, then keywords.
    """
    if code_lang:
        return code_lang
    if filename:
        m = re.match(r"^(en|sp|es|fr)[_\-]", filename, re.I)
        if m:
            return FILE_LANG_PREFIX[m.group(1).lower()]
    for candidate in (url,) + hints:
        path = urllib.parse.urlsplit(candidate or "").path
        # /assets/es_ES/..., /assets/fr_FR/...
        m = re.search(r"/(en|es|fr)_[A-Z]{2}/", path)
        if m:
            return LANG_NAMES[m.group(1).lower()]
        m = re.match(r"^/(es|fr)(/|$)", path)
        if m:
            return LANG_NAMES[m.group(1)]
    blob = " ".join([h for h in hints if h]).lower()
    if re.search(r"(^|[_\-/ ])(sp|esp|spanish|espanol|español|la-vina|vina)([_\-. ]|$)", blob):
        return "Spanish"
    if re.search(r"(^|[_\-/ ])(fr|fre|french|francais|français)([_\-. ]|$)", blob):
        return "French"
    return "English"


# --------------------------------------------------------------------------- #
# Classification
# --------------------------------------------------------------------------- #
ITEM_CODE_RE = re.compile(
    r"(?:^|[/_\-])((?:smfs|smff|smf|smg|fmg|sm|fm|mg|bm|av|cf|fl|lim|sf|ff|sp|fp|sb|fb"
    r"|ps|mr|f|p|m|b|i)[-_]?\d{1,3}[a-z]{0,2})(?:[_\-.]|$)",
    re.I,
)
# Some filenames tack the language onto the number instead of the prefix
# ("cf-36sp", "f-13sp"), so the trailing letters need interpreting rather than
# being kept as part of the number.
CODE_LANG_SUFFIX = {"SP": "Spanish", "ES": "Spanish", "FR": "French", "EN": "English"}

# aa.org numbers the same document differently per language: F-13 (English)
# becomes SF-13 (Spanish) and FF-13 (French). Mapping those back to one base
# code lets the index group translations of a single document together, and
# tells us the language even when the URL gives no locale hint.
CODE_LANG_PREFIX = {
    "sf": ("f", "Spanish"), "ff": ("f", "French"),
    "sp": ("p", "Spanish"), "fp": ("p", "French"),
    "smfs": ("smf", "Spanish"), "smff": ("smf", "French"),
    "smg": ("mg", "Spanish"), "fmg": ("mg", "French"),
    "sb": ("b", "Spanish"), "fb": ("b", "French"),
    # Committee workbooks and display items: M- English, SM- Spanish, FM- French.
    # Every sm-/fm- file on the site follows this, so "SM-" is never an English
    # service-material number (that family is SMF-).
    "sm": ("m", "Spanish"), "fm": ("m", "French"),
}
# Filename prefixes separated by "_" mark the language of the file itself.
FILE_LANG_PREFIX = {"en": "English", "sp": "Spanish", "es": "Spanish", "fr": "French"}

CODE_FAMILIES = {
    "b": "Books & Big Book",
    "mg": "A.A. Guidelines",
    "smf": "Service Material",
    "sm": "Service Material",
    "p": "Pamphlets & Booklets",
    "f": "Forms, Catalogs & Order Blanks",
    "m": "Displays & Wallet Cards",
    "bm": "Newsletters & Bulletins",
    "av": "Audio & Video Resources",
    "lim": "Loners & Internationalists",
    "cf": "Conference & Forum Materials",
    "fl": "Flyers & Announcements",
}

# Matched against the FILENAME ONLY, before anything else.
#
# A periodical's identity lives in its filename; the scraped title is just the
# headline of one article inside it. Without this, "Box 459 - 62nd General
# Service Conference" would file a newsletter issue under Conference reports.
# The same applies to book chapters, whose page titles mention whatever the
# chapter is about ("To Employers" is Big Book chapter 10, not CPC material).
FILENAME_CATEGORY_RULES = [
    (r"box[-_]?459", "Newsletter: Box 4-5-9"),
    (r"markings|(^|[_\-])(s|f)?f[-_]?151([_\-.]|$)", "Newsletter: Markings (Archives)"),
    (r"aaws[-_ ]?highlights?|faits[-_ ]saillants|puntos[-_ ]destacados",
     "Newsletter: AAWS Highlights"),
    (r"(^|[_\-])(s|f)?f[-_]?13([_\-.]|$)|about[-_]?aa|acerca[-_ ]de[-_ ]a",
     "Newsletter: About A.A."),
    (r"(^|[_\-])(s|f)?f[-_]?14([_\-.]|$)|q(uarterly|trly)[-_ ]?report",
     "G.S.O. Quarterly Report"),
    # The corrections newsletter stays with the rest of the corrections material,
    # where someone doing that service work will look for it.
    (r"(^|[_\-])(s|f)?f[-_]?97([_\-.]|$)|behind[-_ ]the[-_ ]walls"
     r"|detr[aá]s[-_ ]de[-_ ]los[-_ ]muros|derri[eè]re[-_ ]les[-_ ]murs",
     "Corrections"),
    (r"(^|[_\-])lim[-_]|loners|internationalist|sea[-_ ]?hawk",
     "Loners & Internationalists"),
    (r"bigbook|big[-_ ]book|livingsober|living[-_ ]sober|(^|[_\-])tt[-_]"
     r"|twelveandtwelve|twelve[-_ ]and[-_ ]twelve|tradition\d|step\d"
     r"|dailyreflection|as[-_ ]bill[-_ ]sees",
     "Big Book, Steps & Traditions"),
]

# (regex, category). First match wins, so order is significant.
CATEGORY_RULES = [
    (r"aa[-_ ]?guidelines|(^|[_\-/])mg[-_]?\d", "A.A. Guidelines"),
    (r"general[-_ ]service[-_ ]conference|(^|[_\-])gsc([_\-]|\d)"
     r"|conference[-_ ]final[-_ ]report|conference[-_ ](agenda|background|advisory)",
     "General Service Conference"),
    (r"world[-_ ]service[-_ ]meeting|(^|[_\-])wsm([_\-]|\d)", "World Service Meeting"),
    (r"regional[-_ ]forum|(^|[_\-])forum[-_ ](report|flyer|sharing|highlight)"
     r"|forum[-_ ]territorial|(^|[_\-])(sw|ws|es|ec|wc|wcen|sen|nen|pr)?rf[-_ ]"
     r"|(^|[_\-])rf[-_ ]?(final|report|flyer)", "Regional Forums"),
    (r"aaws[-_ ]?highlights?|faits[-_ ]saillants|puntos[-_ ]destacados",
     "Newsletter: AAWS Highlights"),
    (r"international[-_ ]convention|regional[-_ ](convention|roundup)|convention", "Conventions & Events"),
    (r"box[-_ ]?4[-_ ]?5[-_ ]?9|box459", "Newsletter: Box 4-5-9"),
    (r"about[-_ ]?a\.?a\.?[-_ ](newsletter|fall|spring|winter|summer)|aboutaa"
     r"|acerca[-_ ]de[-_ ]a\.?a|(^|[_\-])(s|f)?f[-_]?13([_\-.]|$)", "Newsletter: About A.A."),
    (r"markings", "Newsletter: Markings (Archives)"),
    (r"loner|internationalist|(^|[_\-])lim([_\-]|\d)|sea[-_ ]hawk", "Loners & Internationalists"),
    (r"la[-_ ]?vi[nñ]a|grapevine|(^|[_\-])gv[-_ ]", "Grapevine & La Viña"),
    (r"correction|behind[-_ ]the[-_ ]walls|prison|inmate|jail", "Corrections"),
    (r"bridging[-_ ]the[-_ ]gap|bridge[-_ ]the[-_ ]gap|(^|[_\-])btg([_\-]|\d)", "Bridging the Gap"),
    (r"treatment|rehab|detox", "Treatment & Accessibilities"),
    (r"accessib|special[-_ ]needs|deaf|blind|braille|large[-_ ]print|(^|[_\-])asl([_\-]|$)",
     "Treatment & Accessibilities"),
    (r"public[-_ ]information|(^|[_\-])pi([_\-]|\d)|media|press|(^|[_\-])psa([_\-]|$)"
     r"|public[-_ ]service[-_ ]announc|at[-_ ]a[-_ ]glance|aper[cç]u[-_ ]sur"
     r"|un[-_ ]vistazo", "Public Information"),
    (r"cooperation[-_ ]with[-_ ]the[-_ ]professional|(^|[_\-])cpc([_\-]|\d)"
     r"|professional[-_ ]community|employ|human[-_ ]resource|healthcare|health[-_ ]care"
     r"|legal[-_ ]and[-_ ]correction|clergy|physician|nurse|school|student|educator",
     "Cooperation with the Professional Community"),
    (r"archive|history|historical|preservation|digitiz", "Archives & A.A. History"),
    (r"financ|contribution|self[-_ ]support|budget|treasurer|audit", "Finance & Self-Support"),
    (r"young[-_ ]people|(^|[_\-])yp([_\-]|\d)|youth|teen|icypaa", "Young People in A.A."),
    (r"military|armed[-_ ]force|veteran|remote[-_ ]communit|native|indigenous",
     "Military & Remote Communities"),
    (r"anonymit|social[-_ ]media|digital[-_ ]age|internet|online[-_ ]group|website|technolog",
     "Anonymity, Internet & Online Groups"),
    (r"safety|vulnerab|harass", "Safety in A.A."),
    (r"big[-_ ]book|twelve[-_ ]steps|twelve[-_ ]traditions|12[-_ ]steps|12[-_ ]traditions"
     r"|alcoholics[-_ ]anonymous[-_ ]book|living[-_ ]sober|daily[-_ ]reflection|as[-_ ]bill[-_ ]sees",
     "Big Book, Steps & Traditions"),
    (r"service[-_ ]manual|twelve[-_ ]concepts|concepts[-_ ]checklist|structure[-_ ]of[-_ ]a",
     "Service Manual & Concepts"),
    (r"membership[-_ ]survey|survey|statistic|estimat|profile[-_ ]of[-_ ]member",
     "Surveys & Membership Data"),
    (r"catalog|order[-_ ](form|blank)|price[-_ ]list|literature[-_ ]sales",
     "Forms, Catalogs & Order Blanks"),
    (r"group[-_ ](handbook|information|change|form|record)|new[-_ ]group"
     r"|nouveau[-_ ]groupe|nuevo[-_ ]grupo|(^|[_\-])f?[-_]?group([_\-.]|$)"
     r"|(^|[_\-])gsr([_\-]|$)"
     r"|(^|[_\-])dcm([_\-]|$)|area[-_ ]service|district|intergroup|central[-_ ]office"
     r"|answering[-_ ]service|home[-_ ]group|group[-_ ]service",
     "Group, District & Area Service"),
    (r"literature[-_ ]committee|conference[-_ ]approved|literature", "Literature & Committees"),
    (r"sponsor", "Sponsorship"),
    (r"women|men[-_ ]in[-_ ]aa|lgbt|(^|[_\-])gay|transgender|black|african[-_ ]american"
     r"|hispanic|latin|asian|newcomer|atheist|agnostic|belief|religio"
     r"|older[-_ ]alcoholic|alcoh[oó]lico[-_ ]mayor|deaf|senior",
     "Members & Outreach"),
    (r"copyright|licens|trademark|legal|bylaw|certificat|charter", "Legal & Copyright"),
    (r"audio|video|podcast|(^|[_\-])dvd|(^|[_\-])cd[-_ ]", "Audio & Video Resources"),
    (r"flyer|poster|announc|bookmark|placemat|display", "Flyers & Announcements"),
]

TOPIC_TAGS = [
    (r"sponsor", "Sponsorship"),
    (r"newcomer|beginner|new[-_ ]member|first[-_ ]meeting|is[-_ ]a\.?a\.?[-_ ]for", "Newcomer"),
    (r"twelve[-_ ]steps|12[-_ ]steps|step[-_ ]work", "Twelve Steps"),
    (r"twelve[-_ ]traditions|12[-_ ]traditions|tradition", "Twelve Traditions"),
    (r"twelve[-_ ]concepts|concept", "Twelve Concepts"),
    (r"anonymit", "Anonymity"),
    (r"correction|prison|jail|inmate", "Corrections"),
    (r"treatment|rehab", "Treatment"),
    (r"accessib|deaf|blind|special[-_ ]needs|large[-_ ]print|braille", "Accessibility"),
    (r"public[-_ ]information|media|press", "Public Information"),
    (r"professional|cpc|employ|healthcare|clergy|physician|school|student", "Professionals"),
    (r"financ|contribution|self[-_ ]support|treasurer|budget", "Self-Support"),
    (r"archive|history", "Archives"),
    (r"young|youth|teen", "Young People"),
    (r"women", "Women"),
    (r"lgbt|gay|transgender", "LGBTQ+"),
    (r"black|african[-_ ]american", "Black & African American"),
    (r"native|indigenous|remote[-_ ]communit", "Remote Communities"),
    (r"military|veteran|armed[-_ ]force", "Military"),
    (r"safety", "Safety"),
    (r"survey|statistic", "Survey Data"),
    (r"guideline", "Guidelines"),
    (r"group[-_ ](handbook|information|form)|gsr|dcm|district|area[-_ ]", "Group Service"),
    (r"grapevine|vi[nñ]a", "Grapevine"),
    (r"conference|gsc", "Conference"),
    (r"forum", "Regional Forum"),
    (r"newsletter|bulletin|box[-_ ]?4", "Newsletter"),
    (r"catalog|order[-_ ](form|blank)|price", "Catalog / Order"),
    (r"flyer|poster|announc|bookmark", "Flyer / Poster"),
    (r"workbook|kit|checklist|worksheet|guide", "Workbook / Kit"),
    (r"report", "Report"),
    (r"spiritual|prayer|meditation|higher[-_ ]power", "Spirituality"),
    (r"sober|sobriety|relapse", "Sobriety"),
    (r"famil|parent|child|marriage|al[-_ ]?anon", "Family"),
    (r"doctor|medic|drug|medication", "Medical"),
    (r"video|audio|podcast", "Audio / Video"),
    (r"application|form", "Form / Application"),
]

SECTION_RULES = [
    (r"aa-guidelines|(^|[_\-/])mg[-_]?\d", "A.A. Guidelines"),
    (r"service-material|(^|[_\-/])smf?[-_]?\d", "Service Material"),
    (r"newsletter|box-?4-?5-?9|markings|about-?aa|bulletin", "Newsletters"),
    (r"literature|pamphlet|catalog|big-book|book", "Literature"),
    (r"conference|forum|convention|wsm|world-service", "Conference & Events"),
    (r"archive|history", "Archives & History"),
    (r"contribut|financ|self-support", "Finance"),
    (r"group|district|area|intergroup|service", "Service Structure"),
    (r"professional|cpc|treatment|correction|accessib|public-information|military|remote",
     "Carrying the Message"),
    (r"member|newcomer|young|women|beginner", "For Members"),
    (r"resources", "Resources"),
]

# Every category rolls up into exactly one top-level section, so the front-end
# can offer a stable two-level browse tree with no "Other" dead ends.
CATEGORY_SECTION = {
    "A.A. Guidelines": "A.A. Guidelines",
    "Service Material": "Service Material",
    "Pamphlets & Booklets": "Literature",
    "Books & Big Book": "Literature",
    "Big Book, Steps & Traditions": "Literature",
    "Newsletter: AAWS Highlights": "Newsletters",
    "G.S.O. Quarterly Report": "Newsletters",
    "Literature & Committees": "Literature",
    "Forms, Catalogs & Order Blanks": "Forms & Catalogs",
    "Displays & Wallet Cards": "Forms & Catalogs",
    "Flyers & Announcements": "Forms & Catalogs",
    "General Service Conference": "Conference & Events",
    "World Service Meeting": "Conference & Events",
    "Regional Forums": "Conference & Events",
    "Conventions & Events": "Conference & Events",
    "Newsletter: Box 4-5-9": "Newsletters",
    "Newsletter: About A.A.": "Newsletters",
    "Newsletter: Markings (Archives)": "Newsletters",
    "Loners & Internationalists": "Newsletters",
    "Grapevine & La Viña": "Newsletters",
    "Corrections": "Carrying the Message",
    "Treatment & Accessibilities": "Carrying the Message",
    "Public Information": "Carrying the Message",
    "Cooperation with the Professional Community": "Carrying the Message",
    "Bridging the Gap": "Carrying the Message",
    "Military & Remote Communities": "Carrying the Message",
    "Archives & A.A. History": "Archives & History",
    "Finance & Self-Support": "Finance",
    "Group, District & Area Service": "Service Structure",
    "Service Manual & Concepts": "Service Structure",
    "Surveys & Membership Data": "Service Structure",
    "Legal & Copyright": "Service Structure",
    "Young People in A.A.": "For Members",
    "Members & Outreach": "For Members",
    "Sponsorship": "For Members",
    "Safety in A.A.": "For Members",
    "Anonymity, Internet & Online Groups": "For Members",
    "Audio & Video Resources": "Resources",
    "Other Documents": "Resources",
}

STOP_TITLES = re.compile(
    r"^(download|downloads|pdf|download pdf|download the pdf|view pdf|view|open|read|read more"
    r"|more|link|click here|here|en|es|fr|english|spanish|french"
    # Hub pages group back-issues under decade headings ("2020-2029"). Those get
    # scraped as a title for every issue in the decade, so reject them outright.
    r"|\d{4}|\d{4}\s*[-–]\s*\d{4}|\d{4}s|\W*)$",
    re.I,
)

# Periodicals published on aa.org, keyed by the token used in their filenames.
PERIODICALS = [
    (r"box[-_]?459", "Box 4-5-9"),
    (r"markings", "Markings"),
    (r"aaws[-_ ]?highlights?|faits[-_ ]saillants|puntos[-_ ]destacados", "AAWS Highlights"),
    (r"(^|[_\-])(s|f)?f[-_]?13([_\-]|$)|about[-_]?aa|acerca", "About A.A."),
    (r"lim[-_]|loners|internationalist", "Loners-Internationalists Meeting"),
    (r"sea[-_]?hawk", "Sea Hawk"),
    (r"grapevine", "Grapevine"),
]

SEASONS = {"spring": "Spring", "summer": "Summer", "fall": "Fall", "autumn": "Fall",
           "winter": "Winter", "primavera": "Spring", "verano": "Summer",
           "otono": "Fall", "invierno": "Winter"}
MONTHS = {"jan": "January", "january": "January",
          "feb": "February", "february": "February",
          "mar": "March", "march": "March",
          "apr": "April", "april": "April", "may": "May",
          "jun": "June", "june": "June", "jul": "July", "july": "July",
          "aug": "August", "august": "August",
          "sep": "September", "sept": "September", "september": "September",
          "oct": "October", "october": "October",
          "nov": "November", "november": "November",
          "dec": "December", "december": "December"}
# Longest first so "july" is not consumed as "jul".
MONTHS_ALT = "|".join(sorted(MONTHS, key=len, reverse=True))


def _expand_year(token):
    if len(token) == 4:
        return token
    n = int(token)
    return str(1900 + n) if n >= 50 else str(2000 + n)


def periodical_title(filename):
    """Build a real title for a back-issue whose page gave us none.

    'fr_box459_feb-mar69.pdf' -> 'Box 4-5-9 - February-March 1969'
    """
    stem = re.sub(r"\.pdf$", "", urllib.parse.unquote(filename), flags=re.I)
    # Drupal's duplicate suffix ("_0", "_12") -- bounded so a year survives.
    stem = re.sub(r"_\d{1,2}$", "", stem)

    name = ""
    for pattern, label in PERIODICALS:
        if re.search(pattern, stem, re.I):
            name = label
            break
    if not name:
        return ""

    # Season + year, e.g. "spring12" or "spring_2012".
    m = re.search(r"(" + "|".join(SEASONS) + r")[_\-]?((?:19|20)\d{2}|\d{2})\b", stem, re.I)
    if m:
        return "%s - %s %s" % (name, SEASONS[m.group(1).lower()], _expand_year(m.group(2)))

    # Month range or single month, e.g. "feb-mar69" or "oct93".
    months = MONTHS_ALT
    m = re.search(r"(" + months + r")[_\-](" + months + r")[_\-]?((?:19|20)\d{2}|\d{2})\b",
                  stem, re.I)
    if m:
        return "%s - %s-%s %s" % (name, MONTHS[m.group(1).lower()],
                                  MONTHS[m.group(2).lower()], _expand_year(m.group(3)))
    m = re.search(r"(" + months + r")[_\-]?((?:19|20)\d{2}|\d{2})\b", stem, re.I)
    if m:
        return "%s - %s %s" % (name, MONTHS[m.group(1).lower()], _expand_year(m.group(2)))

    m = re.search(r"(?<!\d)((?:19|20)\d{2})(?!\d)", stem)
    if m:
        return "%s - %s" % (name, m.group(1))

    # A trailing word plus a two-digit year, e.g. "conference69".
    m = re.search(r"([a-z]{4,})[_\-]?(\d{2})$", stem, re.I)
    if m and m.group(1).lower() not in ("online", "final", "part"):
        return "%s - %s %s" % (name, m.group(1).capitalize(), _expand_year(m.group(2)))
    return name


# aa.org's Spanish and French pages label nearly every document with the same
# generic link text ("Ver PDF", "Voir PDF", "Descargue la version en PDF").
# A candidate built only from this vocabulary carries no information, so it is
# rejected and the filename is used instead.
GENERIC_TOKENS = set("""
view read open download click here more current issue version page project
about this our the a an and or of for in on to with de del la le el los las un una
ver vea voir lire leer abrir ouvrir abra descargar descargue descarga descargue
telecharger telechargez telecharge cliquez clic haga aqui ici mas plus suite
informacion information numero actual forma corta larga long short form
pdf archivo fichier documento document acerca sobre pour sur ce cette este esta
esto nuestro nuestra notre pagina page enlace lien link version versao
proyecto projet en du des au aux con para por que se dans nos vos y
""".split())

_ACCENTS = str.maketrans("áàâäéèêëíìîïóòôöúùûüñçÁÀÂÄÉÈÊËÍÌÎÏÓÒÔÖÚÙÛÜÑÇ",
                         "aaaaeeeeiiiioooouuuuncAAAAEEEEIIIIOOOOUUUUNC")


# A label that opens with a navigational verb is a button, not a title --
# "Voir edition actuelle", "Lire l'article", "Haga clic aqui para descargar".
LINK_PHRASE_RE = re.compile(
    r"^\s*\.{0,3}\s*("
    r"ver|vea|voir|lire|leer|read|view|open|abrir|ouvrir|download|descargar|descargue"
    r"|t[eé]l[eé]charge[rz]?|haga\s+clic|cliquez|click|consulte[rz]?"
    r"|pour\s+plus|para\s+m[aá]s|for\s+more"
    r"|pour\s+diffusion|para\s+publicaci[oó]n|for\s+immediate\s+release"
    r")\b",
    re.I,
)


def is_generic_link(text):
    """True when every word in the label comes from generic link vocabulary."""
    words = re.findall(r"[^\W\d_]+", text.translate(_ACCENTS).lower(), re.UNICODE)
    if not words:
        return True
    return all(w in GENERIC_TOKENS for w in words)


def prettify_filename(filename):
    stem = re.sub(r"\.pdf$", "", urllib.parse.unquote(filename), flags=re.I)
    stem = re.sub(r"^((?:smf|sm|mg|bm|av|cf|fl|lim|f|p|m|i)[-_]?\d{1,3}[a-z]?)[-_]", "",
                  stem, flags=re.I)
    stem = re.sub(r"_\d{1,2}$", "", stem)        # Drupal duplicate suffix (_0, _1)
    stem = re.sub(r"^(en|sp|es|fr)[_\-]", "", stem, flags=re.I)   # language prefix
    stem = re.sub(r"[_\-](en|sp|es|fr)$", "", stem, flags=re.I)   # language suffix
    stem = re.sub(r"[_\-]+", " ", stem)
    stem = re.sub(r"\b(online|final|web|rev|revised|lores|hires|printable|v\d+"
                  r"|\d{1,2}x\d{1,2})\b", "", stem, flags=re.I)
    stem = re.sub(r"([A-Za-z])((?:19|20)\d{2})\b", r"\1 \2", stem)  # summer2026
    stem = re.sub(r"\s+", " ", stem).strip(" -_")
    if not stem:
        return urllib.parse.unquote(filename)
    return smart_case(stem.lower()) if stem.isupper() or stem.islower() else stem


def smart_case(text):
    """Anchor text on aa.org is often all-lowercase; normalize without
    destroying deliberate capitalization such as 'A.A.' or 'G.S.R.'."""
    letters = [c for c in text if c.isalpha()]
    if letters and not any(c.isupper() for c in letters):
        small = {"a", "an", "the", "of", "for", "and", "or", "to", "in", "on",
                 "with", "at", "as", "by", "from", "is", "are"}
        words = text.split(" ")
        out = []
        for i, w in enumerate(words):
            out.append(w if (i and w.lower() in small) else (w[:1].upper() + w[1:]))
        text = " ".join(out)
    # Dotted initialisms and A.A. service acronyms must stay upper case.
    text = re.sub(r"\b([A-Za-z])\.([A-Za-z])\.", lambda m: "%s.%s." %
                  (m.group(1).upper(), m.group(2).upper()), text)
    text = re.sub(r"\b(aa|gso|gsb|gsr|gsc|dcm|cpc|pi|wsm|asl|lim|btg|ncbi|us|usa|ny)\b",
                  lambda m: m.group(1).upper(), text)
    return text


def best_title(candidates, filename):
    cleaned = []
    for c in candidates:
        c = re.sub(r"\s+", " ", c or "").strip()
        c = re.sub(r"\s*[\(\[]\s*pdf[^\)\]]*[\)\]]\s*$", "", c, flags=re.I)
        c = c.strip(" -–—|·")
        if len(c) < 4 or STOP_TITLES.match(c) or c.lower().endswith(".pdf"):
            continue
        if is_generic_link(c) or LINK_PHRASE_RE.match(c):
            continue
        if len(c) > 160:  # a whole paragraph scraped from a parent element
            continue
        cleaned.append(c)

    issue = periodical_title(filename)
    # A descriptive scraped title beats a generated one; a vague one does not.
    descriptive = [c for c in cleaned if len(c) >= 20]
    if issue and not descriptive:
        return issue
    if not cleaned:
        return prettify_filename(filename)

    # Prefer a candidate that shares vocabulary with the filename -- that is the
    # label actually attached to this file rather than to its containing page.
    stem_words = set(re.findall(r"[a-z]{4,}", prettify_filename(filename).lower()))

    def score(idx_c):
        idx, c = idx_c
        words = set(re.findall(r"[a-z]{4,}", c.lower()))
        overlap = len(words & stem_words)
        return (-overlap, idx)

    best = min(enumerate(cleaned), key=score)[1]
    return smart_case(best)[:300]


def parse_item_code(filename):
    """Return (display_code, base_code, family, language_hint)."""
    m = ITEM_CODE_RE.search(filename)
    if not m:
        return "", "", "", ""
    raw = m.group(1).replace("_", "-").upper()
    if "-" not in raw:
        raw = re.sub(r"^([A-Z]+)(\d)", r"\1-\2", raw)
    prefix, _, number = raw.partition("-")

    # Split "36SP" into the number and a language marker; keep a real variant
    # letter such as the "I" of M-40I or the "A" of P-48A.
    suffix_lang = ""
    m2 = re.match(r"^(\d{1,3})([A-Z]{0,2})$", number)
    if m2:
        number, letters = m2.group(1), m2.group(2)
        if letters in CODE_LANG_SUFFIX:
            suffix_lang = CODE_LANG_SUFFIX[letters]
        else:
            number += letters

    prefix_base, lang_hint = CODE_LANG_PREFIX.get(prefix.lower(), (prefix.lower(), ""))
    base_prefix = prefix_base
    lang_hint = lang_hint or suffix_lang
    raw = prefix.upper() + "-" + number
    base_code = base_prefix.upper() + "-" + number
    family = CODE_FAMILIES.get(base_prefix, "")
    # An "I" suffix on an M- number marks a committee workbook (M-40I) rather
    # than a display piece or wallet card (M-2).
    if base_prefix == "m" and number.lower().endswith("i"):
        family = "Committee Workbooks"
    return raw, base_code, family, lang_hint


def issue_token(stem):
    """A normalized issue identifier ('spring2012') for a periodical filename.

    Without it, every Markings issue would share item code F-151 and look like a
    translation of every other Markings issue.
    """
    seasons = "|".join(SEASONS)
    m = re.search(r"(" + seasons + r")[_\-]?((?:19|20)\d{2}|\d{2})\b", stem, re.I)
    if m:
        return SEASONS[m.group(1).lower()].lower() + _expand_year(m.group(2))
    m = re.search(r"(" + MONTHS_ALT + r")[_\-](" + MONTHS_ALT + r")[_\-]?((?:19|20)\d{2}|\d{2})\b",
                  stem, re.I)
    if m:
        return (MONTHS[m.group(1).lower()] + MONTHS[m.group(2).lower()]).lower() + \
            _expand_year(m.group(3))
    m = re.search(r"(" + MONTHS_ALT + r")[_\-]?((?:19|20)\d{2}|\d{2})\b", stem, re.I)
    if m:
        return MONTHS[m.group(1).lower()].lower() + _expand_year(m.group(2))
    # Quarterly reports: "..._Third_Quarter_2025" / "..._Q3_2025".
    quarters = {"first": "1", "1st": "1", "second": "2", "2nd": "2",
                "third": "3", "3rd": "3", "fourth": "4", "4th": "4"}
    year = re.search(r"(?<!\d)((?:19|20)\d{2})(?!\d)", stem)
    if year:
        m = re.search(r"(" + "|".join(quarters) + r")[_\- ]?quarter", stem, re.I)
        if m:
            return "q" + quarters[m.group(1).lower()] + year.group(1)
        m = re.search(r"(?:^|[_\-])q([1-4])(?:[_\-]|$)", stem, re.I)
        if m:
            return "q" + m.group(1) + year.group(1)
        return year.group(1)

    # Older newsletter files abbreviate the year: "markings1-98" is Spring 1998.
    # Only trusted for known periodicals, so a page range like "_1-20" is safe.
    if any(re.search(pat, stem, re.I) for pat, _ in PERIODICALS):
        m = re.search(r"[_\-](\d{2})$", stem)
        if m:
            return _expand_year(m.group(1))
    return ""


def translation_key(filename, base_code):
    """Group the same document's language editions under one key.

    aa.org numbers translations separately (F-13 / SF-13 / FF-13) and prefixes
    filenames by language (en_ / sp_ / fr_), so neither alone is enough.
    """
    stem = re.sub(r"\.pdf$", "", urllib.parse.unquote(filename), flags=re.I).lower()
    # Only Drupal's "_0"/"_12" duplicate suffix -- never a four-digit year.
    stem = re.sub(r"_\d{1,2}$", "", stem)
    issue = issue_token(stem)
    # A fillable form is a separate edition of the same item number.
    variant = "-fillable" if re.search(r"fillable", stem, re.I) else ""
    if base_code:
        if issue:
            return base_code + "|" + issue + variant
        # Books are split into page ranges that share one item code; the page
        # numbers are what distinguish a part from its translation.
        rest = ITEM_CODE_RE.sub("_", stem, count=1)
        parts = re.findall(r"\d+", rest)
        return base_code + "|" + ("p" + "-".join(parts) if parts else "") + variant

    # No item code: fall back to the filename with language markers removed.
    stem = re.sub(r"^(en|sp|es|fr)[_\-]", "", stem)
    stem = re.sub(r"[_\-](en|sp|es|fr)$", "", stem)
    stem = re.sub(r"\b(online|final|web|rev|revised|lores|hires|printable|v\d+)\b", "", stem)
    stem = re.sub(r"[^a-z0-9]+", "", stem)
    return "stem:" + stem if stem else ""


def classify(pdf_url, title, source_page, source_title):
    filename = urllib.parse.unquote(
        urllib.parse.urlsplit(pdf_url).path.rsplit("/", 1)[-1])
    slug = urllib.parse.urlsplit(source_page).path
    hay = " ".join([filename, title or "", slug, source_title or ""]).lower()

    item_code, base_code, family, _lang = parse_item_code(filename)

    category = ""
    for pattern, name in FILENAME_CATEGORY_RULES:
        if re.search(pattern, filename, re.I):
            category = name
            break
    if not category:
        for pattern, name in CATEGORY_RULES:
            if re.search(pattern, hay, re.I):
                category = name
                break
    if not category:
        category = family or "Other Documents"

    section = CATEGORY_SECTION.get(category, "")
    if not section:
        for pattern, name in SECTION_RULES:
            if re.search(pattern, hay, re.I):
                section = name
                break
    if not section:
        section = "Resources"

    topics = []
    for pattern, tag in TOPIC_TAGS:
        if re.search(pattern, hay, re.I) and tag not in topics:
            topics.append(tag)

    return item_code, base_code, family, category, section, topics


YEAR_RE = re.compile(r"(19[3-9]\d|20[0-4]\d)")


def guess_year(*parts):
    """Pick the publication year, ignoring impossible future years that come
    from item numbers or phone numbers that happen to look like dates."""
    cutoff = datetime.now(timezone.utc).year + 1
    years = []
    for p in parts:
        years += [y for y in YEAR_RE.findall(urllib.parse.unquote(p or ""))
                  if 1935 <= int(y) <= cutoff]
    if not years:
        return ""
    return max(years)


# --------------------------------------------------------------------------- #
# Crawl
# --------------------------------------------------------------------------- #
def load_sitemap(fetcher):
    urls = set()
    body, _ = fetcher.text(SITEMAP_INDEX)
    if not body:
        return urls
    pages = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", body)
    sub = [p for p in pages if "sitemap" in p]
    if not sub:
        sub = [SITEMAP_INDEX]
    for sm in sub:
        sbody, _ = fetcher.text(sm)
        if not sbody:
            continue
        for loc in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", sbody):
            n = normalize(loc, SITE)
            if n and crawlable(n):
                urls.add(n)
    return urls


def extract(page_url, html):
    """Return (pdf_hits, internal_links, page_title)."""
    soup = BeautifulSoup(html, "lxml")
    title_tag = soup.find("h1") or soup.find("title")
    page_title = re.sub(r"\s+", " ", title_tag.get_text(" ", strip=True)) if title_tag else ""
    page_title = re.sub(r"\s*\|\s*Alcoholics Anonymous\s*$", "", page_title).strip()

    pdf_hits, internal = [], set()

    for tag in soup.find_all(["a", "iframe", "embed", "object", "source"]):
        raw = tag.get("href") or tag.get("src") or tag.get("data") or ""
        url = normalize(raw, page_url)
        if not url:
            continue
        if is_pdf_link(url):
            text = tag.get_text(" ", strip=True) if tag.name == "a" else ""
            candidates = [
                text,
                tag.get("title") or "",
                tag.get("aria-label") or "",
                tag.get("data-entity-title") or "",
            ]
            # Walk up for a heading or list item that labels the link.
            parent = tag.parent
            for _ in range(4):
                if parent is None:
                    break
                head = parent.find(["h1", "h2", "h3", "h4", "h5", "strong"])
                if head:
                    candidates.append(head.get_text(" ", strip=True))
                parent = parent.parent
            pdf_hits.append((url, candidates))
        elif crawlable(url):
            internal.add(url)

    # Catch PDF URLs that only appear inside inline JSON, data attributes or
    # scripts -- absolute, protocol-relative, or site-root-relative.
    raw_pdf_re = re.compile(
        r"(?:https?:)?//[^\s\"'<>\\)]+?\.pdf(?:\?[^\s\"'<>\\)]*)?"
        r"|(?<![\w.])/[\w\-./%]+?\.pdf(?:\?[^\s\"'<>\\)]*)?",
        re.I,
    )
    for match in raw_pdf_re.finditer(html):
        url = normalize(match.group(0), page_url)
        if url and is_pdf_link(url):
            pdf_hits.append((url, []))

    return pdf_hits, internal, page_title


def crawl(fetcher, seeds, max_pages, workers, extra_depth):
    seen = set()
    queue = deque()
    for s in sorted(seeds):
        seen.add(s)
        queue.append((s, 0))

    records = {}          # canonical pdf url -> record dict
    page_titles = {}
    pages_done = 0
    lock = threading.Lock()

    def work(item):
        url, depth = item
        html, final = fetcher.text(url)
        if not html:
            return url, depth, [], set(), ""
        pdfs, links, title = extract(final or url, html)
        return url, depth, pdfs, links, title

    with ThreadPoolExecutor(max_workers=workers) as pool:
        while queue and pages_done < max_pages:
            batch = []
            while queue and len(batch) < workers * 4:
                batch.append(queue.popleft())
            for url, depth, pdfs, links, title in pool.map(work, batch):
                pages_done += 1
                if title:
                    page_titles[url] = title
                for pdf_url, candidates in pdfs:
                    key = canonical_pdf(pdf_url)
                    rec = records.get(key)
                    if rec is None:
                        rec = {
                            "url": key,
                            "raw_urls": {pdf_url},
                            "candidates": [],
                            "sources": [],
                        }
                        records[key] = rec
                    rec["raw_urls"].add(pdf_url)
                    rec["candidates"].extend([c for c in candidates if c])
                    if url not in rec["sources"]:
                        rec["sources"].append(url)
                if depth < extra_depth:
                    for link in links:
                        if link not in seen:
                            seen.add(link)
                            queue.append((link, depth + 1))
            sys.stderr.write("\r  pages: %d  queued: %d  pdfs: %d   "
                             % (pages_done, len(queue), len(records)))
            sys.stderr.flush()
    sys.stderr.write("\n")
    return records, page_titles, pages_done


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #
FIELDS = [
    "id", "title", "url", "filename", "item_code", "base_code", "translation_key",
    "item_code_family",
    "category", "section", "language", "topics", "year", "bytes", "size_human",
    "last_modified", "source_page", "source_title", "source_count", "host", "status",
]


def human_size(n):
    if not n:
        return ""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return ("%.0f %s" if unit == "B" else "%.1f %s") % (n, unit)
        n /= 1024.0
    return ""


def best_source(sources, filename):
    """A file linked from many pages gets credited to the most specific page --
    a landing page about that document, not the site root or a hub listing."""
    if not sources:
        return ""
    stem_words = set(re.findall(r"[a-z]{4,}", prettify_filename(filename).lower()))

    def score(url):
        path = urllib.parse.urlsplit(url).path
        if path in ("", "/"):
            return (1, 0, 0, url)  # the homepage is the worst possible source
        slug_words = set(re.findall(r"[a-z]{4,}", path.lower()))
        return (0, -len(slug_words & stem_words), len(path), url)

    return min(sources, key=score)


def iso_date(http_date):
    if not http_date:
        return ""
    for fmt in ("%a, %d %b %Y %H:%M:%S %Z", "%a, %d %b %Y %H:%M:%S GMT"):
        try:
            return datetime.strptime(http_date, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return ""


def build_rows(records, page_titles, fetcher, workers, verify, heads_cache=None):
    keys = sorted(records)

    heads = {}
    if verify and heads_cache and all(k in heads_cache for k in keys):
        sys.stderr.write("  using cached file metadata for %d files\n" % len(keys))
        heads = {k: heads_cache[k] for k in keys}
    elif verify:
        sys.stderr.write("  verifying %d files...\n" % len(keys))
        done = [0]
        lock = threading.Lock()

        def probe(key):
            info = fetcher.head(key)
            with lock:
                done[0] += 1
                if done[0] % 25 == 0:
                    sys.stderr.write("\r  verified: %d/%d   " % (done[0], len(keys)))
                    sys.stderr.flush()
            return key, info

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for key, info in pool.map(probe, keys):
                heads[key] = info
        sys.stderr.write("\n")

    # aa.org keeps legacy /sites/default/files/... URLs that 301 to the same
    # file on the Widen CDN, so one document can appear under two links. Fold
    # them together on the resolved URL, keeping the link that needs no
    # redirect and merging what we learned from both source pages.
    if heads:
        by_final = defaultdict(list)
        for key in keys:
            final = ((heads.get(key) or {}).get("final_url") or key).lower().rstrip("/")
            by_final[final].append(key)
        deduped = []
        for final, group in by_final.items():
            if len(group) > 1:
                group.sort(key=lambda k: (
                    0 if ((heads.get(k) or {}).get("final_url") or "").lower() == k.lower() else 1,
                    len(k), k))
                keep = group[0]
                for other in group[1:]:
                    for s in records[other]["sources"]:
                        if s not in records[keep]["sources"]:
                            records[keep]["sources"].append(s)
                    records[keep]["candidates"].extend(records[other]["candidates"])
            deduped.append(group[0])
        if len(deduped) != len(keys):
            sys.stderr.write("  merged %d duplicate links that resolve to the same file\n"
                             % (len(keys) - len(deduped)))
        keys = sorted(deduped)

    rows = []
    for key in keys:
        rec = records[key]
        filename = urllib.parse.urlsplit(key).path.rsplit("/", 1)[-1]
        source_page = best_source(rec["sources"], filename)
        source_title = page_titles.get(source_page, "")
        candidates = rec["candidates"] + [source_title]
        title = best_title(candidates, filename)
        item_code, base_code, family, category, section, topics = classify(
            key, title, source_page, source_title
        )
        if not verify:
            status = "ok"
        else:
            info = heads.get(key)
            if not info:
                status = "unreachable"
            elif "pdf" not in (info.get("content_type") or "").lower():
                # aa.org still publishes legacy /assets/*.pdf links that now 301
                # to an HTML landing page. Those are not documents.
                status = "not-a-pdf"
            else:
                status = "ok"
        info = heads.get(key) or {}

        rows.append({
            "id": "",
            "title": title,
            "url": key,
            "filename": filename,
            "item_code": item_code,
            "base_code": base_code,
            "translation_key": translation_key(
                urllib.parse.unquote(filename), base_code),
            "item_code_family": family,
            "category": category,
            "section": section,
            "language": language_of(
                source_page or key, filename, title,
                filename=urllib.parse.unquote(filename),
                code_lang=parse_item_code(urllib.parse.unquote(filename))[3],
            ),
            "topics": "; ".join(topics),
            "year": guess_year(filename, title, source_page),
            "bytes": info.get("bytes", 0),
            "size_human": human_size(info.get("bytes", 0)),
            "last_modified": iso_date(info.get("last_modified", "")),
            "source_page": source_page,
            "source_title": source_title,
            "source_count": len(rec["sources"]),
            "host": urllib.parse.urlsplit(key).netloc,
            "status": status,
        })

    # Keep live PDFs in the index; keep the rest as a separate broken-link report.
    good = [r for r in rows if r["status"] == "ok"]
    broken = [r for r in rows if r["status"] != "ok"]
    good.sort(key=lambda r: (r["category"], r["title"].lower()))
    for i, r in enumerate(good, 1):
        r["id"] = i
    build_rows.last_heads = heads
    return good, broken


def write_outputs(rows, broken, pages_crawled, fetcher):
    os.makedirs(DATA_DIR, exist_ok=True)
    csv_path = os.path.join(DATA_DIR, "pdfs.csv")
    with open(csv_path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    # Transparency report: links aa.org publishes that no longer serve a PDF.
    with open(os.path.join(DATA_DIR, "broken_links.csv"), "w", newline="",
              encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh, fieldnames=["url", "title", "status", "source_page"],
            extrasaction="ignore", lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(sorted(broken, key=lambda r: r["url"]))

    def by(field):
        counts = Counter(r[field] for r in rows if r[field])
        return dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))

    topic_counts = Counter(
        t.strip() for r in rows for t in (r["topics"] or "").split(";") if t.strip()
    )

    groups = defaultdict(set)
    for r in rows:
        if r["translation_key"]:
            groups[r["translation_key"]].add(r["language"])
    translated_groups = {k: v for k, v in groups.items() if len(v) > 1}
    translated_rows = sum(
        1 for r in rows
        if r["translation_key"] in translated_groups
    )

    meta = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generated_date": datetime.now(timezone.utc).strftime("%B %d, %Y"),
        "source": SITE,
        "total_pdfs": len(rows),
        "pages_crawled": pages_crawled,
        "broken_links": len(broken),
        "total_bytes": sum(r["bytes"] or 0 for r in rows),
        "categories": by("category"),
        "sections": by("section"),
        "languages": by("language"),
        "topics": dict(sorted(topic_counts.items(), key=lambda kv: (-kv[1], kv[0]))),
        "translation_groups": len(translated_groups),
        "translated_documents": translated_rows,
        "item_code_families": by("item_code_family"),
        "http": dict(fetcher.stats),
        "pdf_hosts_seen": dict(SEEN_PDF_HOSTS.most_common()),
        "pdf_hosts_skipped": {
            h: SKIPPED_PDF_SAMPLES[h] for h in SKIPPED_PDF_SAMPLES
        },
    }
    with open(os.path.join(DATA_DIR, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
    return csv_path, meta


CACHE_PATH = os.path.join(ROOT, ".cache", "crawl_raw.json")


def save_cache(records, page_titles, pages, heads=None):
    """Persist the raw crawl so classification can be re-run offline."""
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    payload = {
        "pages": pages,
        "page_titles": page_titles,
        "heads": heads or {},
        "records": {
            k: {"sources": v["sources"], "candidates": v["candidates"]}
            for k, v in records.items()
        },
    }
    with open(CACHE_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)


def load_cache():
    with open(CACHE_PATH, encoding="utf-8") as fh:
        payload = json.load(fh)
    records = {
        k: {"url": k, "raw_urls": {k}, "sources": v["sources"], "candidates": v["candidates"]}
        for k, v in payload["records"].items()
    }
    return records, payload["page_titles"], payload["pages"], payload.get("heads", {})


def main():
    ap = argparse.ArgumentParser(description="Index every PDF linked from www.aa.org")
    ap.add_argument("--max-pages", type=int, default=12000)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--depth", type=int, default=3,
                    help="extra link-following depth beyond the sitemap")
    ap.add_argument("--delay", type=float, default=0.0)
    ap.add_argument("--no-verify", action="store_true",
                    help="skip HEAD requests for size / last-modified")
    ap.add_argument("--reclassify", action="store_true",
                    help="rebuild the CSV from the cached crawl instead of re-crawling")
    args = ap.parse_args()

    fetcher = Fetcher(delay=args.delay)

    if args.reclassify:
        if not os.path.exists(CACHE_PATH):
            sys.stderr.write("ERROR: no crawl cache at %s -- run a full crawl first.\n"
                             % CACHE_PATH)
            return 1
        sys.stderr.write("Rebuilding from cached crawl...\n")
        records, page_titles, pages, heads = load_cache()
        rows, broken = build_rows(records, page_titles, fetcher, args.workers,
                                  not args.no_verify, heads_cache=heads)
        csv_path, meta = write_outputs(rows, broken, pages, fetcher)
        save_cache(records, page_titles, pages, build_rows.last_heads)
        sys.stderr.write("Wrote %s (%d live PDFs)\n" % (csv_path, len(rows)))
        return 0

    sys.stderr.write("Loading sitemap...\n")
    seeds = load_sitemap(fetcher)
    seeds.add(SITE + "/")
    sys.stderr.write("  %d sitemap URLs\n" % len(seeds))
    if len(seeds) < 50:
        sys.stderr.write("ERROR: sitemap yielded too few URLs; aborting so a bad run\n"
                         "       cannot overwrite a good index.\n")
        return 1

    sys.stderr.write("Crawling...\n")
    records, page_titles, pages = crawl(
        fetcher, seeds, args.max_pages, args.workers, args.depth
    )
    sys.stderr.write("  %d unique PDF URLs from %d pages\n" % (len(records), pages))
    if not records:
        sys.stderr.write("ERROR: no PDFs found; refusing to write an empty index.\n")
        return 1

    rows, broken = build_rows(records, page_titles, fetcher, args.workers,
                              not args.no_verify)
    if not rows:
        sys.stderr.write("ERROR: every candidate failed verification; "
                         "refusing to overwrite the index.\n")
        return 1
    csv_path, meta = write_outputs(rows, broken, pages, fetcher)
    save_cache(records, page_titles, pages, build_rows.last_heads)

    sys.stderr.write("\nWrote %s (%d live PDFs, %d dead links reported)\n"
                     % (csv_path, len(rows), len(broken)))
    sys.stderr.write("Categories: %d | Languages: %s\n"
                     % (len(meta["categories"]), meta["languages"]))

    sys.stderr.write("\nPDF links by host:\n")
    for host, n in SEEN_PDF_HOSTS.most_common():
        mark = "  " if host in ALLOWED_PDF_HOSTS else "! "
        sys.stderr.write("  %s%-34s %5d%s\n"
                         % (mark, host, n,
                            "" if host in ALLOWED_PDF_HOSTS else "   NOT INDEXED"))
    if SKIPPED_PDF_SAMPLES:
        sys.stderr.write("\nPDF hosts linked from aa.org but not indexed -- review whether\n"
                         "they belong in ALLOWED_PDF_HOSTS:\n")
        for host, sample in SKIPPED_PDF_SAMPLES.items():
            sys.stderr.write("  %s\n    e.g. %s\n" % (host, sample[:110]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
