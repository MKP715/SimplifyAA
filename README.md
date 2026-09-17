# SimplifyAA

A searchable, categorized index of **every PDF published on aa.org** — in one page.

aa.org holds thousands of documents, but there is no single list of them. They are scattered across
landing pages, hub pages, decade-collapsed newsletter archives, paginated listings, and a separate
digital-asset host (`aaws.widen.net`). If you don't already know a document's exact name, you are
unlikely to find it.

This project crawls the entire site, collects every PDF link, sorts them into sections, categories and
topics, and serves the result as a single static page you can search, filter and share.

**2,918 documents** — 1,124 English, 921 Spanish, 873 French — found across 5,401 pages and sorted
into 12 sections, 38 categories and 37 topics. 2,482 of them are cross-linked to their translations.

**➡️ Live site:** https://mkp715.github.io/SimplifyAA/

---

## Not an official A.A. site

This is an independent, unofficial index built by a member. It is **not** produced by, endorsed by, or
affiliated with Alcoholics Anonymous World Services, Inc. or the A.A. General Service Office.

**No documents are re-hosted here.** The index stores only link metadata — title, URL, item code, file
size, last-modified date, and the aa.org page the link was found on. Every result opens the official
file on aa.org. All literature remains the copyright of its publisher.

---

## What's in the repository

| Path | What it is |
|---|---|
| `index.html` | The entire web app — markup, styles and logic in one file, as required for simple GitHub Pages hosting. |
| `sw.js` | Service worker: offline support and the background check for new documents. A worker has to be its own file. |
| `site.webmanifest` | Makes it installable as an app. |
| `data/changes.json` | What each crawl added or removed, newest first — the basis for "new documents" and notifications. |
| `data/crawl_state.json` | Sitemap fingerprint and last-crawl time, so a check can tell whether a crawl is needed. |
| `data/pdfs.csv` | The document index. One row per PDF. Regenerated automatically. |
| `data/meta.json` | Counts and the last-rebuild timestamp, shown in the page footer. |
| `data/broken_links.csv` | Links aa.org publishes that no longer resolve to a PDF (see below). |
| `tools/crawl_aa_pdfs.py` | The crawler and classifier. |
| `tools/build_kits.py` | Reads each kit's contents PDF and matches the item numbers it names. |
| `data/kits.csv` | Kit membership: one row per kit, language and listed item. |
| `tools/test_ui.js` | Browser regression tests for the page (search, filters, translations, preview, mobile). |
| `tools/test_kits.js` | Browser regression tests for the service-kit view. |
| `tools/test_viewers.js` | Browser regression tests for the PDF viewer options, including iPhone emulation. |
| `tools/test_pwa.js` | Browser regression tests for install, offline use and new-document notifications. |
| `tools/test_layout.js` | Browser regression tests for the resizable sidebar and the card layout controls. |
| `tools/test_i18n.js` | Browser regression tests for the Spanish and French interface. |
| `tools/test_mobile.js` | Phone layout tests, plus guards that the phone work has not changed desktop. |
| `data/i18n.json` | Spanish and French interface text, keyed by the English source string. |
| `outreach/` | A ready-to-send report of the broken links found on aa.org, for their web team. |
| `tools/test_results_pane.js` | Browser regression tests for the filter bar, sorting, grouping and icons. |
| `tools/make_favicon.py` | Generates the site icons and web manifest from one original mark. |
| `tools/audit.js` | Debug audit: dangling references, duplicate ids, accessibility, blocked storage, missing data. |
| `tools/verify_coverage.py` | Re-fetches aa.org pages to prove no PDF link is missing from the index. |
| `tools/should_crawl.py` | Decides from the sitemap whether a full crawl is worth running. |
| `.github/workflows/update-index.yml` | Weekly re-crawl, commit, and Pages deploy. |

The data deliberately lives in CSV rather than inside `index.html`, so the page stays small and the
index can be regenerated without touching application code.

## Using the page

- **Search** — type in the box (or press <kbd>/</kbd>). Fuzzy matching covers titles, item codes,
  topics and aa.org's own one-line description of each document, so you can search for what a
  document is *about* and not only for its catalogue name. "anonimity" and "p-47" both find the
  right pamphlet, and typing anything switches the order to **Best match** automatically.
- **Read it in Spanish or French** — the interface, the categories and the topics all translate;
  pick a language in the header. Two thirds of the catalogue is not in English.
- **Browse** — the sidebar tree goes *section → category*, with live counts.
- **Filter** — stack language and topic filters on top of any search.
- **Cards or table** — cards for reading, table for sorting and scanning. Columns can be
  reordered, and hidden or shown from the header menu.
- **Filter further** — the **Filters** bar narrows by literature type (from the item code),
  Conference-approved vs service material, file size, when aa.org last updated it, a year range,
  and switches for "available in another language", "included in a service kit" and favourites.
  The button badges how many filters are active, and each one appears as a removable chip.
- **Sort and arrange** — it opens on **date updated, newest first**, so you see what A.A. has just
  refreshed; change it and that choice is remembered for next time, while a shared link still shows
  the sender's order. Sort by best match, title, date updated, year, size, item code, category or
  language, in either direction; group the results by category, section, language, literature type or
  decade; and choose 12–240 results per page, or all of them at once.
- **Fit it to your screen** — drag the divider to set the sidebar width (arrow keys work too, and
  a double-click resets it), choose how many cards sit across, and pick comfortable or compact
  cards. These are remembered per device and are deliberately kept out of shared links, so your
  layout is never imposed on anyone else.
- **Service kits** — every committee kit as a set of working links, workbook first (see below).
- **Preview** — read a PDF without leaving the page, with a choice of viewer (see below).
- **Collections** — star documents into named lists (a packet for a new G.S.R., the reading for
  a workshop). Share one with a link that carries the whole list inside it, export or import it as
  a file, or print it as a plain handout. Nothing is stored on a server.
- **What changed** — new *and revised* documents are listed and notified, with a visible history
  of every crawl that found something.
- **Recently opened**, **keyboard shortcuts** (<kbd>?</kbd> lists them), adjustable **text size**,
  and reduced-motion support.
- **Kit checklists** — tick items off as you assemble a kit; progress is remembered per kit.
- **Share a view** — the URL captures the exact search and filters, so you can send someone a link
  straight to, say, every Spanish corrections document.
- **Start over** — click **SimplifyAA** in the header to go back to all documents, clearing the
  search and every filter. A **Clear all** chip also appears beside the active filters once there
  is more than one, and the sidebar keeps its **Reset all filters** button. Your own preferences
  — sort order, theme, viewer, card size — are left alone.
- **Export** — download the current result list as CSV.
- **Install it** — it runs as an app and works offline; see below.
- **New documents** — the bell lists what each crawl added, with a history you can clear.

Colour is used in two places only, and never as the only signal — the text always says the same
thing. Item numbers are tinted by family, so a pamphlet number reads differently from a guideline
number at a glance (`P-` green, `B-` indigo, `F-`/`CF-` teal, `SMF-` amber, `MG-` purple, workbooks
rose); the **Item codes** panel shows the same colours next to their meanings. Language chips carry a
hue per language, filled for the edition you are looking at. A date shown in green means aa.org
refreshed that file within the last 30 days.

## Understanding A.A. item codes

Most A.A. literature carries a code. Once you know the prefix, the catalog stops being a maze. The
page has a built-in glossary, in short:

| Prefix | Meaning |
|---|---|
| `P-` | Conference-approved pamphlets |
| `B-` | Books, including the Big Book |
| `F-` | Forms, catalogs, flyers and service pieces |
| `SMF-` | Service material (not Conference-approved) |
| `MG-` | A.A. Guidelines |
| `M-` | Committee workbooks when the number ends in `I` (`M-40I`), otherwise displays and wallet cards |
| `BM-` | Bulletins such as Box 4-5-9 |
| `CF-` | Conference and forum material |

Note that `SM-` is *not* an English service-material number — it is the Spanish edition of an `M-`
item (`SM-40I` is the Spanish Treatment workbook), and `FM-` is the French one.

## Installing it as an app

The page is a progressive web app. On Android and on desktop Chrome or Edge an **Install app** button
appears in the header; on iPhone and iPad use **Share → Add to Home Screen**, since Safari offers no
install button. Installed, it opens in its own window, has its own icon, and long-pressing that icon
jumps straight to Service kits, New documents or Recently updated.

It also **works with no signal**. The service worker caches the interface and the index, so the whole
catalogue stays searchable at a meeting with no reception. The documents themselves are not cached —
those are aa.org's files and are fetched when you open them.

## Being told about new documents

Each crawl records what it added or removed in `data/changes.json`. The app compares that against
what this device has already seen and lists anything new under **New documents**, and the bell in the
header keeps a history you can read and clear.

**How far this can go, honestly.** A GitHub Pages site is static — there is no server that can send a
push message. So notifications are produced by the service worker waking up and checking
`changes.json` itself, using Periodic Background Sync. That means:

| Device | Told about new documents |
|---|---|
| Android / desktop Chrome or Edge, **installed** | In the background, with the app closed |
| Any other browser, including Safari and Firefox | When you next open the app |

The **Notifications** panel states which of those applies to the device you are reading on, rather
than leaving you to guess. Nothing is sent to a third-party push service: no member's reading is
reported to anyone, which matters more here than the convenience would. If true server-sent push is
ever wanted, it needs a small backend to hold subscriptions and send them — the worker already
handles a `push` event, so only the sender would be missing.

## On a phone

The sidebar holds the search box, the browse tree, language and topics. Stacked above the results on
a phone that was 1,600px of filters before a single document appeared — four and a half screens of
scrolling on a small iPhone. So below 992px:

- the sidebar becomes a **slide-in drawer**, opened from the header or the bottom bar, and closes
  itself once you pick a category so you see the results rather than the drawer;
- a **sticky search bar** keeps search and the result count reachable without scrolling back up;
- a **bottom action bar** puts Browse, Filters, Kits, Lists and Top within thumb reach, with targets
  comfortably past the 44px guidance;
- `viewport-fit=cover` and safe-area insets keep the fixed bars clear of a notch or home bar;
- the **Start here** shortcuts become one swipeable row instead of a 13-button block, and the
  heading, count and Filters button — all duplicated by the two bars — are dropped.

Measured effect on the distance to the first result:

| Device | Before | After |
|---|---:|---:|
| iPhone SE (320px) | 2,713px | **502px** |
| Android (360px) | 2,505px | **463px** |
| iPhone 14 (390px) | 2,382px | **463px** |
| iPhone Plus (428px) | 2,255px | **424px** |

Every one of those changes lives inside a `max-width: 991.98px` query or a `d-lg-none` class, and
`tools/test_mobile.js` asserts at 1500, 1200 and 992px that the desktop layout still has its inline
resizable sidebar, no bars, no reserved padding and nothing hidden.

## Icons

`tools/make_favicon.py` generates `favicon.ico` (multi-size), `favicon.svg`, an Apple touch icon,
192/512px PNGs and `site.webmanifest` from one original mark — a plain document glyph. The manifest
means the page can be added to a phone's home screen and open like an app.

The mark is deliberately generic. A.A.'s circle-and-triangle is a registered mark of A.A. World
Services and is not used here, because this is an unofficial index and should not look like an
official one.

## PDF previews and why they need options

There is no single way to show a PDF that works on every device:

- **iPhone and iPad** will not render a PDF inside a frame at all — Apple's browsers show nothing.
- **Some Android browsers** download the file instead of displaying it.
- **An in-page reader** (pdf.js) avoids all of that by drawing the pages itself, but it has to *fetch*
  the file, which needs a CORS header. `aaws.widen.net` sends `Access-Control-Allow-Origin: *`;
  `www.aa.org` sends nothing. That is 617 documents the reader can open and 2,301 it cannot.

So the viewer is a setting rather than a guess. **Settings** offers:

| Viewer | How it works | Where it works |
|---|---|---|
| **Automatic** (default) | Browser viewer on devices that support it; in-page reader on Apple devices where the file allows it; otherwise a new tab | Everywhere, nothing leaves the page |
| **Browser viewer** | `<iframe>` — the browser's own PDF viewer | Desktop; blank on iOS |
| **Embedded** | `<object>` — embedded differently | Worth trying on Android |
| **In-page reader** | pdf.js renders pages to canvas | Everywhere, but only the 617 Widen-hosted files |
| **Google viewer** | Google renders it server-side | Almost anywhere — **sends the document's URL to Google** |
| **New tab** | Hands the file to the device | Always |

Every preview also carries a **"Not displaying? Try another viewer"** bar, so a blank preview is one tap
from a working one, and the choice is remembered. Preview height is adjustable, and saved settings can
be cleared.

The Google viewer is opt-in and never selected automatically, because it discloses which document is
being read to a third party — which matters in a fellowship built on anonymity. Everything else stays
between the device and aa.org.

## Service kits

G.S.O. ships a kit to each committee — a workbook plus a set of pamphlets, guidelines and service
pieces. What is *in* a kit is only stated inside that kit's own contents PDF (F-167 for Treatment,
F-68 for Corrections, and so on), so the kit is useless as a shopping list unless you open it and
look up each item number by hand.

`tools/build_kits.py` reads each contents list, extracts the A.A. item numbers it names, and matches
them against the document index. The **Service kits** view then presents each kit as a set of working
links, grouped the way the printed list reads:

- the committee **workbook** first (`M-40I`, `M-45I`, …),
- then pamphlets, books, service material, guidelines, and forms,
- with anything the list names but aa.org does not publish as a PDF marked **print item**, so you
  know it exists rather than wondering whether the index missed it.

12 kits, 368 listed items, 298 of them available as PDFs. Kits are language-aware: choosing Spanish
shows the Spanish contents list *and* the Spanish edition of each item. Each kit is deep-linkable
(`#view=kits&kit=F-167`), and every document elsewhere in the index shows which kits include it.

Two committees — Archives (`M-44I`) and Literature (`M-52I`) — have a workbook but no kit contents
list on aa.org; those are listed separately rather than dropped.

Kits are **discovered, not hard-coded**: candidates are found by title, then confirmed only if the PDF
actually names several other item numbers. A new kit on aa.org is picked up on the next run, and the
press kit and convention toolkit are correctly rejected because they list no item numbers.

Only item numbers are extracted from those PDFs. Titles, sizes and links all come from the document
index, so nothing from inside a document is copied.

## How translations are matched

aa.org numbers translations separately — `F-13` (English) becomes `SF-13` (Spanish) and `FF-13`
(French) — and also prefixes filenames by language (`en_`, `sp_`, `fr_`). Neither signal alone is
enough, and the item code alone is actively misleading: every issue of *Markings* shares code `F-151`,
so grouping on it would present 81 unrelated issues as translations of each other.

The crawler therefore builds a `translation_key` from the base item code **plus an issue
discriminator** — the season, month, quarter or year parsed out of the filename — falling back to a
language-stripped filename when there is no item code (which is how the Box 4-5-9 archive is matched).
Multi-part documents, such as the page ranges of *Living Sober*, are separated by their page numbers.

The result: 843 translation groups covering 2,482 documents. In the interface each document shows
`EN · ES · FR` chips with the current language highlighted; the others are one click away, including
inside the PDF preview.

## How it stays current

`.github/workflows/update-index.yml` runs **every 6 hours** — 00:00, 06:00, 12:00 and 18:00 UTC —
and on demand via **Actions → Run workflow**. A new document therefore appears within hours rather
than within a week.

A *check* is not a *crawl*, though, and the difference matters. A full crawl is about 5,400 page
requests plus a HEAD for every document; doing that four times a day would mean roughly 86,000
requests a day against a nonprofit's website, almost always to discover that nothing changed.

So each run first asks the sitemap what changed, which costs three requests. The sitemap index is no
use for this — Drupal regenerates it hourly regardless — but every URL entry carries a real content
timestamp, so a fingerprint over all 4,544 `(url, lastmod)` pairs says whether anything was published
or edited. A full crawl then runs only when:

- the fingerprint differs from the last crawl, **or**
- the last full crawl is more than 24 hours old — because aa.org can replace a PDF without touching
  the page that links it, which no sitemap timestamp would reveal, **or**
- the sitemap cannot be read at all, in which case it crawls rather than risk going stale, **or**
- you tick **force** when running it by hand.

The result is four checks a day, changes picked up within hours, a guaranteed full crawl daily, and
none of the wasted load. `data/crawl_state.json` holds the fingerprint and the last crawl time, and
the run summary states which path it took.

Two safeguards stop a bad run from replacing a good index:

1. The crawler refuses to write an empty or near-empty result.
2. The workflow aborts if the document count drops more than 30% from the previous run — the signature
   of aa.org changing its structure or blocking the crawler.

The workflow works with either Pages setting. If Pages is set to **GitHub Actions** the deploy job
publishes the new commit; if it is set to **Deploy from a branch**, that commit publishes on its own
and the deploy job is allowed to fail without turning the run red. Either way the site follows the
committed data.

### One-time setup

In **Settings → Pages**, set the source to **GitHub Actions**. That is all; the workflow handles the rest.

> **Worth knowing:** GitHub disables scheduled workflows in a repository that has had no commits for
> 60 days, and emails the owner first. Because this workflow only commits when aa.org actually changes,
> a long quiet spell is possible. If the schedule stops, re-enable it under **Actions** — or just
> press **Run workflow** occasionally, which resets the clock.

## Running it yourself

```bash
pip install -r requirements.txt

# Full crawl (~15 minutes)
python tools/crawl_aa_pdfs.py

# Re-run only the classification, using the cached crawl (instant)
python tools/crawl_aa_pdfs.py --reclassify

# Rebuild the service-kit contents (reads ~37 kit PDFs)
python tools/build_kits.py
```

Useful flags: `--depth N` (how far to follow links beyond the sitemap), `--max-pages N`,
`--workers N`, `--no-verify` (skip the file-size/date checks), `--delay SECONDS`.

To view the site locally, serve the folder rather than opening the file directly — browsers block
local data loading from `file://`:

```bash
python -m http.server 8000   # then open http://localhost:8000
```

### Testing the page

`tools/test_ui.js` drives real Chrome and checks the facets, search (including item codes),
translation chips, filters, shareable URLs, both views, favorites, the preview modal and the mobile
layout, failing on any console error:

```bash
npm install puppeteer-core
python -m http.server 8765 &
node tools/test_ui.js http://127.0.0.1:8765/index.html ./shots
node tools/test_kits.js http://127.0.0.1:8765/index.html
node tools/test_viewers.js http://127.0.0.1:8765/index.html
node tools/test_results_pane.js http://127.0.0.1:8765/index.html
node tools/test_pwa.js http://127.0.0.1:8765/index.html
node tools/test_layout.js http://127.0.0.1:8765/index.html
node tools/test_i18n.js http://127.0.0.1:8765/index.html
node tools/test_mobile.js http://127.0.0.1:8765/index.html
node tools/audit.js http://127.0.0.1:8765/index.html index.html
```

Set `CHROME_PATH` if Chrome is not at the default Windows location.

`tools/audit.js` is a separate debug pass rather than a pass/fail suite. It checks that every id the
script references exists, that there are no duplicate ids, that every control has an accessible name
and every field a label, that non-English titles carry a `lang` attribute so screen readers pronounce
them correctly, and that the page still works with `localStorage` blocked (private browsing) or with
`data/kits.csv` missing.

## Coverage

Getting *everything* takes more than reading the sitemap:

- **The sitemap lists no PDFs at all** — only the 4,544 pages. Every document has to be found by
  reading those pages, plus three levels of links out of them.
- **Listing pages paginate.** `/news-and-announcements?page=7` carries documents that appear nowhere
  else. Skipping `?page=` query strings hid 257 documents; the crawler now follows pager links
  (and only pager links — facets and sorts just re-slice the same documents).
- **Some links are only in inline JSON**, not in an `<a>` tag, so the raw HTML is scanned as well.
- **Documents are not all on one host.** Besides `www.aa.org` and `aaws.widen.net`, aa.org links a
  few live PDFs on `www.aagrapevine.org`, and sometimes leaks its Acquia origin hostname
  (`alcanonymous1.prod.acquia-sites.com`) into links. The crawler now reports every host it sees a
  PDF on, marking any that are not indexed, so a new file host cannot be missed silently.

Completeness is checked independently by `tools/verify_coverage.py`, which re-fetches pages straight
from aa.org and confirms every PDF link on them is accounted for — indexed, or recorded as a dead
link. The last run covered **528 pages** (400 random sitemap pages plus every paginated hub page) and
found **853 of 853 links covered, 0 missing**. The crawler separately reports every host it sees a PDF
on, and currently skips none.

```bash
python tools/verify_coverage.py --sample 400
```

## About `broken_links.csv`

aa.org still links to legacy `/assets/**.pdf` URLs that now redirect to HTML landing pages instead of
serving a file. The crawler verifies every candidate and keeps only links that really return a PDF;
the 29 that fail are recorded in `data/broken_links.csv`. If you maintain anything that links into
aa.org, that file is worth a look.

Other legacy `/sites/default/files/**.pdf` URLs *do* still work, but only by redirecting to the same
file on the Widen CDN — which is separately indexed. Those are folded together on the resolved URL, so
one document is one row (21 duplicates merged on the last run).

## Built with

[Bootstrap 5](https://getbootstrap.com/), [Bootstrap Icons](https://icons.getbootstrap.com/),
[Tabulator](https://tabulator.info/), [Papa Parse](https://www.papaparse.com/) and
[Fuse.js](https://fusejs.io/) — all open source, all from public CDNs. The crawler uses
[Beautiful Soup](https://www.crummy.com/software/BeautifulSoup/) and
[lxml](https://lxml.de/).
