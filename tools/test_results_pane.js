// Tests for the results-pane controls in index.html.
//
//   node tools/test_results_pane.js http://127.0.0.1:8765/index.html
//
// Covers the filter bar (literature type, status, size, updated, year range,
// the three switches), sort field and direction, grouping, page size, card
// density, clearing, URL round-tripping, and the site icons.
// Set SHOTS for screenshots; CHROME_PATH for Chrome.

const puppeteer = require("puppeteer-core");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || ".";
const URL = process.argv[2] || "http://127.0.0.1:8765/index.html";
let fails = 0;
const check = (n, c, d) => {
  console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? "  [" + d + "]" : ""));
  if (!c) fails++;
};

const count = (p) => p.evaluate(() => {
  const m = document.querySelector("#resultCount").textContent.match(/[\d,]+/);
  return m ? parseInt(m[0].replace(/,/g, ""), 10) : 0;
});
const setSel = (p, sel, val) => p.evaluate((s, v) => {
  const n = document.querySelector(s);
  n.value = v;
  n.dispatchEvent(new Event("change"));
}, sel, val);
// Read and set the sort direction from the icon, rather than assuming which
// way round it starts — the default is now newest-first.
const curDir = (p) => p.evaluate(() =>
  document.querySelector("#sortDir .bi-sort-down") ? "desc" : "asc");
const setDir = async (p, want) => {
  for (let i = 0; i < 3; i++) {
    if ((await curDir(p)) === want) return want;
    await p.evaluate(() => document.querySelector("#sortDir").click());
    await sleep(700);
  }
  return curDir(p);
};
const toggle = (p, sel) => p.evaluate((s) => {
  const n = document.querySelector(s);
  n.checked = !n.checked;
  n.dispatchEvent(new Event("change"));
}, sel);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: "new", args: ["--no-sandbox"],
  });
  const p = await browser.newPage();
  await p.setViewport({ width: 1560, height: 1100 });
  const errors = [];
  p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  p.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await p.goto(URL, { waitUntil: "networkidle2" });
  await p.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent),
    { timeout: 45000 });
  await sleep(700);
  const total = await count(p);

  console.log("=== ICONS / MANIFEST ===");
  const icons = await p.evaluate(() => ({
    ico: !!document.querySelector('link[rel="icon"][href="favicon.ico"]'),
    svg: !!document.querySelector('link[rel="icon"][href="favicon.svg"]'),
    apple: !!document.querySelector('link[rel="apple-touch-icon"]'),
    manifest: (document.querySelector('link[rel="manifest"]') || {}).href || "",
    theme: (document.querySelector('meta[name="theme-color"]') || {}).content || "",
  }));
  check("favicon.ico linked", icons.ico);
  check("favicon.svg linked", icons.svg);
  check("apple touch icon linked", icons.apple);
  check("web manifest linked", /site\.webmanifest$/.test(icons.manifest), icons.manifest.slice(-20));
  check("theme colour set", icons.theme === "#1f6f8b", icons.theme);
  const assets = await p.evaluate(async () => {
    const out = {};
    for (const f of ["favicon.ico", "favicon.svg", "apple-touch-icon.png",
                     "icon-192.png", "icon-512.png", "site.webmanifest"]) {
      try { const r = await fetch(f); out[f] = r.status; } catch (e) { out[f] = "ERR"; }
    }
    return out;
  });
  check("all icon files load", Object.values(assets).every((v) => v === 200),
    JSON.stringify(assets));

  console.log("\n=== FIRST-RUN DEFAULTS ===");
  // Fresh profile, nothing saved: a member opening this cold should land on
  // what aa.org has just refreshed.
  const firstRun = await p.evaluate(() => ({
    sort: document.querySelector("#sortSel").value,
    dir: document.querySelector("#sortDir .bi-sort-down") ? "desc" : "asc",
    saved: localStorage.getItem("simplifyaa.settings"),
  }));
  check("opens sorted by date updated", firstRun.sort === "last_modified", firstRun.sort);
  check("opens newest first", firstRun.dir === "desc", firstRun.dir);
  check("nothing was saved before the reader chose anything",
    !firstRun.saved || !JSON.parse(firstRun.saved).sortField, String(firstRun.saved));
  const dates = await p.evaluate(() =>
    [...document.querySelectorAll("#cardsWrap .sa-card")].slice(0, 8)
      .map((c) => (c.textContent.match(/[0-9]{4}-[0-9]{2}-[0-9]{2}/) || [""])[0])
      .filter(Boolean));
  check("the newest dates really are first",
    dates.length > 2 && dates.every((d, i) => i === 0 || dates[i - 1] >= d),
    dates.slice(0, 4).join(" >= "));

  console.log("\n=== FILTER BAR OPENS ===");
  const bar = await p.evaluate(() => ({
    btn: !!document.querySelector("#filterToggle"),
    families: document.querySelectorAll("#familyChips [data-family]").length,
    yearFrom: document.querySelectorAll("#yearFrom option").length,
    badgeHidden: document.querySelector("#filterCount").classList.contains("d-none"),
  }));
  check("filters button present", bar.btn);
  check("literature-type chips built", bar.families >= 6, bar.families + " chips");
  check("year range populated", bar.yearFrom > 30, bar.yearFrom + " options");
  check("badge hidden when nothing is filtered", bar.badgeHidden);
  await p.evaluate(() => document.querySelector("#filterToggle").click());
  await sleep(700);
  check("filter bar expands", await p.evaluate(() =>
    document.querySelector("#filterBar").classList.contains("show")));

  console.log("\n=== EACH FILTER NARROWS ===");
  const famName = await p.evaluate(() => {
    const c = document.querySelector("#familyChips [data-family]");
    c.click();
    return c.dataset.family;
  });
  await sleep(600);
  let n = await count(p);
  check("literature type filters", n > 0 && n < total, famName + " = " + n);
  check("badge counts it", await p.evaluate(() =>
    document.querySelector("#filterCount").textContent === "1"));
  await p.evaluate(() => document.querySelector("#familyChips [data-family].active").click());
  await sleep(500);

  for (const [sel, val, label] of [["#approvalSel", "approved", "Conference-approved"],
                                   ["#sizeSel", "l", "Large files"],
                                   ["#updatedSel", "365", "Updated in 12 months"]]) {
    await setSel(p, sel, val);
    await sleep(600);
    n = await count(p);
    check(label + " filters", n > 0 && n < total, n + " docs");
    await setSel(p, sel, "");
    await sleep(400);
  }

  await setSel(p, "#yearFrom", "2020");
  await setSel(p, "#yearTo", "2024");
  await sleep(700);
  n = await count(p);
  check("year range filters", n > 0 && n < total, "2020-2024 = " + n);
  const yearsOk = await p.evaluate(() =>
    [...document.querySelectorAll("#cardsWrap .sa-meta")].length > 0);
  check("year range returns cards", yearsOk);
  // Backwards range must not silently return nothing.
  await setSel(p, "#yearFrom", "2024");
  await setSel(p, "#yearTo", "2020");
  await sleep(700);
  check("reversed year range still works", (await count(p)) === n, await count(p) + " vs " + n);
  await setSel(p, "#yearFrom", "");
  await setSel(p, "#yearTo", "");
  await sleep(400);

  await toggle(p, "#fTrans");
  await sleep(600);
  n = await count(p);
  check("translations switch filters", n > 0 && n < total, n + " with translations");
  await toggle(p, "#fTrans");
  await sleep(400);

  await toggle(p, "#fKit");
  await sleep(600);
  n = await count(p);
  check("service-kit switch filters", n > 0 && n < total, n + " in kits");
  await toggle(p, "#fKit");
  await sleep(400);

  console.log("\n=== FILTERS STACK, THEN CLEAR ===");
  await p.evaluate(() => document.querySelector("#familyChips [data-family]").click());
  await setSel(p, "#approvalSel", "service");
  await setSel(p, "#sizeSel", "m");
  await sleep(800);
  const stacked = await count(p);
  const badge = await p.evaluate(() => document.querySelector("#filterCount").textContent);
  check("three filters stack", stacked <= total, stacked + " docs, badge " + badge);
  check("badge reflects three filters", badge === "3", badge);
  const chips = await p.evaluate(() =>
    [...document.querySelectorAll("#activeChips .badge")].map((b) => b.textContent.trim()));
  check("active filters shown as chips", chips.length >= 3, chips.join(" | ").slice(0, 90));
  await p.evaluate(() => document.querySelector("#clearFilters").click());
  await sleep(700);
  check("clear filters restores everything", (await count(p)) === total, await count(p) + "");
  check("badge hidden again", await p.evaluate(() =>
    document.querySelector("#filterCount").classList.contains("d-none")));

  console.log("\n=== SORTING ===");
  const firstTitles = async () => p.evaluate(() =>
    [...document.querySelectorAll("#cardsWrap .sa-card-title")].slice(0, 3)
      .map((e) => e.textContent.trim()));
  await setSel(p, "#sortSel", "title");
  await sleep(600);
  const asc = await firstTitles();
  await p.evaluate(() => document.querySelector("#sortDir").click());
  await sleep(700);
  const desc = await firstTitles();
  check("sort direction reverses the list", asc[0] !== desc[0],
    (asc[0] || "").slice(0, 26) + " vs " + (desc[0] || "").slice(0, 26));
  check("direction icon flips", (await curDir(p)) === "asc", "now " + (await curDir(p)));

  await setSel(p, "#sortSel", "bytes");
  await setDir(p, "desc");
  await sleep(700);
  const bySize = await p.evaluate(() =>
    [...document.querySelectorAll("#cardsWrap .sa-card")].slice(0, 6).map((c) => {
      const m = c.textContent.match(/([\d.]+)\s(KB|MB|B)/);
      if (!m) return 0;
      const v = parseFloat(m[1]);
      return m[2] === "MB" ? v * 1024 : m[2] === "B" ? v / 1024 : v;
    }));
  const descOrder = bySize.every((v, i) => i === 0 || bySize[i - 1] >= v);
  check("sorting by size really orders by size", descOrder, bySize.join(" >= "));

  await setSel(p, "#sortSel", "year");
  await sleep(600);
  check("sorting by year works", (await count(p)) === total);
  await setSel(p, "#sortSel", "title");
  await p.evaluate(() => document.querySelector("#sortDir").click());
  await sleep(500);

  console.log("\n=== GROUPING ===");
  await setSel(p, "#groupSel", "category");
  await sleep(800);
  let g = await p.evaluate(() => ({
    heads: [...document.querySelectorAll("#cardsWrap .col-12 .fw-semibold")].map((h) => h.textContent.trim()),
    cards: document.querySelectorAll("#cardsWrap .sa-card").length,
  }));
  check("category grouping adds headers", g.heads.length > 0,
    g.heads.slice(0, 3).join(" | ") + " (" + g.cards + " cards)");
  await setSel(p, "#groupSel", "decade");
  await sleep(800);
  g = await p.evaluate(() =>
    [...document.querySelectorAll("#cardsWrap .col-12 .fw-semibold")].map((h) => h.textContent.trim()));
  check("decade grouping works", g.length > 0 && g.every((x) => /0s$|No year/.test(x)),
    g.slice(0, 4).join(" | "));
  await p.screenshot({ path: SHOTS + "/30-grouped.png" });
  await setSel(p, "#groupSel", "");
  await sleep(500);

  console.log("\n=== PAGE SIZE & DENSITY ===");
  await setSel(p, "#pageSizeSel", "24");
  await sleep(700);
  check("page size 24 applied", await p.evaluate(() =>
    document.querySelectorAll("#cardsWrap .sa-card").length === 24),
    await p.evaluate(() => document.querySelectorAll("#cardsWrap .sa-card").length) + " cards");
  await setSel(p, "#pageSizeSel", "96");
  await sleep(800);
  check("page size 96 applied", await p.evaluate(() =>
    document.querySelectorAll("#cardsWrap .sa-card").length === 96));
  await p.evaluate(() =>
    document.querySelector('#densityGroup [data-density="compact"]').click());
  await sleep(600);
  check("compact density applied", await p.evaluate(() =>
    document.querySelector("#cardsWrap").classList.contains("sa-compact")));
  await p.screenshot({ path: SHOTS + "/31-compact.png" });

  console.log("\n=== URL ROUND-TRIP ===");
  await setSel(p, "#approvalSel", "approved");
  await setSel(p, "#groupSel", "section");
  await sleep(800);
  const before = await count(p);
  const hash = await p.evaluate(() => location.hash);
  check("every control is in the URL",
    /status=approved/.test(hash) && /group=section/.test(hash) &&
    /per=96/.test(hash) && /density=compact/.test(hash), hash.slice(0, 96));
  await p.reload({ waitUntil: "networkidle2" });
  await p.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent),
    { timeout: 45000 });
  await sleep(900);
  const after = await count(p);
  const restored = await p.evaluate(() => ({
    approval: document.querySelector("#approvalSel").value,
    group: document.querySelector("#groupSel").value,
    per: document.querySelector("#pageSizeSel").value,
    compact: document.querySelector("#cardsWrap").classList.contains("sa-compact"),
  }));
  check("shared link restores the same results", before === after, before + " vs " + after);
  check("shared link restores every control",
    restored.approval === "approved" && restored.group === "section" &&
    restored.per === "96" && restored.compact, JSON.stringify(restored));

  console.log("\n=== SORT CHOICE IS REMEMBERED ===");
  await setSel(p, "#sortSel", "title");
  await setDir(p, "asc");
  await sleep(700);
  const savedSort = await p.evaluate(() =>
    JSON.parse(localStorage.getItem("simplifyaa.settings") || "{}"));
  check("a changed sort is saved",
    savedSort.sortField === "title" && savedSort.sortDir === "asc",
    JSON.stringify({ f: savedSort.sortField, d: savedSort.sortDir }));

  // A plain revisit, with no parameters in the link, must reopen that way.
  await p.goto(URL, { waitUntil: "networkidle2" });
  await p.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent),
    { timeout: 45000 });
  await sleep(900);
  const reopened = await p.evaluate(() => ({
    sort: document.querySelector("#sortSel").value,
    dir: document.querySelector("#sortDir .bi-sort-down") ? "desc" : "asc",
  }));
  check("reopens with the reader's own sort",
    reopened.sort === "title" && reopened.dir === "asc", JSON.stringify(reopened));

  // Someone else's shared link should show their order, not the reader's.
  await p.goto(URL + "#sort=bytes&dir=desc", { waitUntil: "networkidle2" });
  await p.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent),
    { timeout: 45000 });
  await sleep(900);
  const shared = await p.evaluate(() => ({
    sort: document.querySelector("#sortSel").value,
    dir: document.querySelector("#sortDir .bi-sort-down") ? "desc" : "asc",
  }));
  check("a shared link overrides the saved sort",
    shared.sort === "bytes" && shared.dir === "desc", JSON.stringify(shared));

  console.log("\n=== TABLE VIEW OPTIONS ===");
  await p.evaluate(() => document.querySelector("#resetAll").click());
  await sleep(600);
  await p.evaluate(() => document.querySelector("label[for=vmTable]").click());
  await sleep(1600);
  const t = await p.evaluate(() => ({
    rows: document.querySelectorAll("#tableWrap .tabulator-row").length,
    movable: !!document.querySelector("#tableWrap .tabulator-col[tabulator-field]"),
  }));
  check("table still renders", t.rows > 5, t.rows + " rows");
  await setSel(p, "#groupSel", "language");
  await sleep(1500);
  const groups = await p.evaluate(() =>
    document.querySelectorAll("#tableWrap .tabulator-group").length);
  check("table grouping works", groups > 0, groups + " groups");
  await p.screenshot({ path: SHOTS + "/32-table-grouped.png" });
  await setSel(p, "#groupSel", "");
  await sleep(900);

  console.log("\n=== RESET ===");
  await p.evaluate(() => document.querySelector("label[for=vmCards]").click());
  await sleep(500);
  await p.evaluate(() => document.querySelector("#resetAll").click());
  await sleep(800);
  check("reset returns the full list", (await count(p)) === total, await count(p) + "");
  check("reset clears the filter badge", await p.evaluate(() =>
    document.querySelector("#filterCount").classList.contains("d-none")));
  check("start-here row returns on a clean slate", await p.evaluate(() =>
    !document.querySelector("#startHere").classList.contains("d-none")));

  console.log("\n=== MOBILE ===");
  await p.setViewport({ width: 390, height: 844 });
  await sleep(800);
  const overflow = await p.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth + 2);
  check("no horizontal overflow with the new controls", !overflow);
  await p.evaluate(() => document.querySelector("#filterToggle").click());
  await sleep(700);
  const mOverflow = await p.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth + 2);
  check("filter bar fits a phone", !mOverflow);
  await p.screenshot({ path: SHOTS + "/33-mobile-filters.png" });

  console.log("\n=== CONSOLE ===");
  check("no console errors", errors.length === 0, errors.length + "");
  errors.slice(0, 8).forEach((e) => console.log("     - " + e.slice(0, 150)));

  await browser.close();
  console.log("\n" + (fails ? "FAILURES: " + fails : "ALL RESULTS-PANE CHECKS PASSED"));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
