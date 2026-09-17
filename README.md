# SimplifyAA

A searchable, categorized index of **every PDF published on aa.org** — in one page.

aa.org holds thousands of documents, but there is no single list of them. They are scattered across
landing pages, hub pages, decade-collapsed newsletter archives, paginated listings, and a separate
digital-asset host (`aaws.widen.net`). If you don't already know a document's exact name, you are
unlikely to find it.

This project crawls the entire site, collects every PDF link, sorts them into sections, categories and
topics, and serves the result as a single static page you can search, filter and share.

**2,914 documents** — 1,123 English, 919 Spanish, 872 French — found across 5,401 pages and sorted
into 12 sections, 38 categories and 37 topics. 2,447 of them are cross-linked to their translations.

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
| `data/pdfs.csv` | The document index. One row per PDF. Regenerated automatically. |
| `data/meta.json` | Counts and the last-rebuild timestamp, shown in the page footer. |
| `data/broken_links.csv` | Links aa.org publishes that no longer resolve to a PDF (see below). |
| `tools/crawl_aa_pdfs.py` | The crawler and classifier. |
| `tools/test_ui.js` | Browser regression tests for the page (search, filters, translations, preview, mobile). |
| `.github/workflows/update-index.yml` | Weekly re-crawl, commit, and Pages deploy. |

The data deliberately lives in CSV rather than inside `index.html`, so the page stays small and the
index can be regenerated without touching application code.

## Using the page

- **Search** — type in the box (or press <kbd>/</kbd>). Fuzzy matching covers titles, item codes and
  topics, so "anonimity" and "p-47" both find the right pamphlet.
- **Browse** — the sidebar tree goes *section → category*, with live counts.
- **Filter** — stack language and topic filters on top of any search.
- **Cards or table** — cards for reading, table for sorting and scanning.
- **Preview** — read a PDF inline without leaving the page.
- **Favorites** — star documents you use often; they are remembered in your browser.
- **Share a view** — the URL captures the exact search and filters, so you can send someone a link
  straight to, say, every Spanish corrections document.
- **Export** — download the current result list as CSV.

## Understanding A.A. item codes

Most A.A. literature carries a code. Once you know the prefix, the catalog stops being a maze. The
page has a built-in glossary, in short:

| Prefix | Meaning |
|---|---|
| `P-` | Conference-approved pamphlets |
| `B-` | Books, including the Big Book |
| `F-` | Forms, catalogs, flyers and service pieces |
| `SM-` / `SMF-` | Service material (not Conference-approved) |
| `MG-` | A.A. Guidelines |
| `M-` | Displays and wallet cards |
| `BM-` | Bulletins such as Box 4-5-9 |

## How translations are matched

aa.org numbers translations separately — `F-13` (English) becomes `SF-13` (Spanish) and `FF-13`
(French) — and also prefixes filenames by language (`en_`, `sp_`, `fr_`). Neither signal alone is
enough, and the item code alone is actively misleading: every issue of *Markings* shares code `F-151`,
so grouping on it would present 81 unrelated issues as translations of each other.

The crawler therefore builds a `translation_key` from the base item code **plus an issue
discriminator** — the season, month, quarter or year parsed out of the filename — falling back to a
language-stripped filename when there is no item code (which is how the Box 4-5-9 archive is matched).
Multi-part documents, such as the page ranges of *Living Sober*, are separated by their page numbers.

The result: 831 translation groups covering 2,447 documents. In the interface each document shows
`EN · ES · FR` chips with the current language highlighted; the others are one click away, including
inside the PDF preview.

## How it stays current

`.github/workflows/update-index.yml` runs every Monday (and on demand via **Actions → Run workflow**).
It re-crawls aa.org, rebuilds the CSV, commits any changes, and redeploys the site. No manual work.

Two safeguards stop a bad run from replacing a good index:

1. The crawler refuses to write an empty or near-empty result.
2. The workflow aborts if the document count drops more than 30% from the previous run — the signature
   of aa.org changing its structure or blocking the crawler.

### One-time setup

In **Settings → Pages**, set the source to **GitHub Actions**. That is all; the workflow handles the rest.

> **Worth knowing:** GitHub disables scheduled workflows in a repository that has had no commits for
> 60 days, and emails the owner first. Because this workflow only commits when aa.org actually changes,
> a long quiet spell is possible. If the weekly run stops, re-enable it under **Actions** — or just
> press **Run workflow** occasionally, which resets the clock.

## Running it yourself

```bash
pip install -r requirements.txt

# Full crawl (~15 minutes)
python tools/crawl_aa_pdfs.py

# Re-run only the classification, using the cached crawl (instant)
python tools/crawl_aa_pdfs.py --reclassify
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
```

Set `CHROME_PATH` if Chrome is not at the default Windows location.

## Coverage

Getting *everything* takes more than reading the sitemap:

- **The sitemap lists no PDFs at all** — only the 4,544 pages. Every document has to be found by
  reading those pages, plus three levels of links out of them.
- **Listing pages paginate.** `/news-and-announcements?page=7` carries documents that appear nowhere
  else. Skipping `?page=` query strings hid 257 documents; the crawler now follows pager links
  (and only pager links — facets and sorts just re-slice the same documents).
- **Some links are only in inline JSON**, not in an `<a>` tag, so the raw HTML is scanned as well.

Completeness is checked by re-fetching random aa.org pages and confirming every PDF link on them is
accounted for. The last audit covered 400 random pages plus 128 paginated listing pages: **every link
was either indexed or correctly excluded as dead.**

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
