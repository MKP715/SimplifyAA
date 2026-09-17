// UI regression tests for index.html.
//
//   npm install puppeteer-core
//   python -m http.server 8765 &
//   node tools/test_ui.js http://127.0.0.1:8765/index.html ./shots
//
// Set CHROME_PATH if Chrome is not at the default Windows location.
// Exits non-zero if any check fails.

const puppeteer = require("puppeteer-core");

const CHROME = process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.argv[2] || "http://localhost:8765/index.html";
const OUT = process.argv[3] || ".";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (detail ? "  [" + detail + "]" : ""));
  if (!cond) failures++;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });

  const errors = [];
  // URLs this harness probes itself; their aborts are not app errors.
  const probed = new Set();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("requestfailed", (r) => {
    if (probed.has(r.url())) return;
    errors.push("REQFAIL: " + r.url() + " " + ((r.failure() || {}).errorText || ""));
  });

  await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent),
    { timeout: 45000 });
  await sleep(700);

  const read = () => page.evaluate(() => ({
    total: document.querySelector("#statTotal").textContent.trim(),
    count: document.querySelector("#resultCount").textContent.trim(),
    n: parseInt((document.querySelector("#resultCount").textContent.match(/[\d,]+/) || ["0"])[0]
        .replace(/,/g, ""), 10),
    heading: document.querySelector("#resultHeading").textContent.trim(),
    cards: document.querySelectorAll("#cardsWrap .sa-card").length,
    sections: [...document.querySelectorAll("#tree .accordion-button")]
      .map((b) => b.textContent.trim().replace(/\s+/g, " ")),
    langs: [...document.querySelectorAll("#langGroup button")].map((b) => b.textContent.trim()),
    topics: document.querySelectorAll("#topics .sa-chip").length,
    years: document.querySelectorAll("#yearFrom option").length,
    startLinks: document.querySelectorAll("#startLinks button").length,
    errorBanner: !document.querySelector("#loadError").classList.contains("d-none"),
    firstCard: (document.querySelector("#cardsWrap .sa-card-title") || {}).textContent,
  }));

  console.log("\n=== LOAD ===");
  const init = await read();
  console.log(JSON.stringify({ total: init.total, sections: init.sections.length,
    langs: init.langs, topics: init.topics, years: init.years,
    startLinks: init.startLinks }, null, 1));
  check("index loaded without error banner", !init.errorBanner);
  check("documents present", init.n > 2000, init.n + " docs");
  check("browse tree built", init.sections.length >= 8, init.sections.length + " sections");
  check("no 'Other' dead-end section", !init.sections.some((s) => /^Other\d/.test(s)));
  check("language facet built", init.langs.length === 4, init.langs.join("|"));
  check("year facet built", init.years > 30, init.years + " options");
  check("start-here doors built", init.startLinks >= 8, init.startLinks + " doors");
  await page.screenshot({ path: OUT + "/01-initial.png" });

  console.log("\n=== SEARCH ===");
  await page.type("#q", "corrections");
  await sleep(700);
  let r = await read();
  check("text search narrows results", r.n > 0 && r.n < init.n, r.n + " hits");

  await page.evaluate(() => { document.querySelector("#q").value = ""; });
  await page.type("#q", "p-47");
  await sleep(700);
  r = await read();
  const codeHits = await page.evaluate(() =>
    [...document.querySelectorAll("#cardsWrap .sa-code")].map((e) => e.textContent.trim()));
  check("item-code search is precise", r.n <= 6, r.n + " hits");
  check("item-code search returns that code", codeHits.every((c) => /47/.test(c)),
    codeHits.join(","));
  await page.screenshot({ path: OUT + "/02-search.png" });

  console.log("\n=== TRANSLATIONS ===");
  const trans = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#cardsWrap .sa-card")];
    const withChips = cards.filter((c) => c.querySelector(".bi-translate"));
    const first = withChips[0];
    if (!first) return { withChips: 0 };
    const chips = [...first.querySelectorAll(".bi-translate")][0]
      .parentElement.querySelectorAll("a,span.badge");
    return {
      withChips: withChips.length,
      total: cards.length,
      chipLabels: [...chips].map((c) => c.textContent.trim()),
      chipHrefs: [...chips].map((c) => c.getAttribute("href") || "CURRENT"),
    };
  });
  console.log("  " + JSON.stringify(trans));
  check("edition chips render", trans.withChips > 0, trans.withChips + "/" + trans.total + " cards");
  check("chips show language codes",
    (trans.chipLabels || []).every((l) => /^(EN|ES|FR)$/.test(l)), (trans.chipLabels||[]).join(","));
  check("exactly one current edition",
    (trans.chipHrefs || []).filter((h) => h === "CURRENT").length === 1);
  check("sibling chips link to real PDFs",
    (trans.chipHrefs || []).filter((h) => h !== "CURRENT").every((h) => /\.pdf/i.test(h)));

  // Verify a translation sibling actually resolves.
  const siblingUrl = (trans.chipHrefs || []).find((h) => h !== "CURRENT");
  if (siblingUrl) {
    probed.add(siblingUrl);
    const status = await page.evaluate(async (u) => {
      try { const res = await fetch(u, { method: "HEAD" });
            return res.status + " " + (res.headers.get("content-type") || ""); }
      catch (e) { return "ERR " + e.message; }
    }, siblingUrl);
    check("translation link resolves to a PDF", /200.*pdf/i.test(status), status);
  }

  console.log("\n=== FILTERS ===");
  await page.click("#resetAll");
  await sleep(400);
  await page.evaluate(() => document.querySelector("#tree .accordion-button").click());
  await sleep(500);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("#tree [data-cat]")]; if (b.length) b[0].click(); });
  await sleep(600);
  const browsed = await read();
  check("category browse filters", browsed.n > 0 && browsed.n < init.n,
    browsed.heading + " = " + browsed.n);

  await page.evaluate(() => {
    const b = [...document.querySelectorAll("#langGroup button")]
      .find((x) => /Spanish/.test(x.textContent)); if (b) b.click(); });
  await sleep(500);
  const esFiltered = await read();
  check("language filter stacks", esFiltered.n > 0 && esFiltered.n < browsed.n,
    esFiltered.n + " Spanish");

  await page.click("#resetAll");
  await sleep(400);
  const yr = await page.evaluate(() => {
    const sel = document.querySelector("#yearFrom");
    const opt = [...sel.options].find((o) => o.value && /^(19|20)/.test(o.value));
    sel.value = opt.value; sel.dispatchEvent(new Event("change"));
    document.querySelector("#yearTo").value = opt.value;
    document.querySelector("#yearTo").dispatchEvent(new Event("change"));
    return opt.value;
  });
  await sleep(600);
  const yearFiltered = await read();
  check("year filter works", yearFiltered.n > 0 && yearFiltered.n < init.n,
    "year " + yr + " = " + yearFiltered.n);

  console.log("\n=== STATE / SHARE ===");
  const hash = await page.evaluate(() => location.hash);
  check("filters captured in URL", /from=/.test(hash), hash);
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent), { timeout: 30000 });
  await sleep(700);
  const restored = await read();
  check("shared URL restores the view", restored.n === yearFiltered.n,
    restored.n + " vs " + yearFiltered.n);

  console.log("\n=== VIEWS ===");
  await page.click("#resetAll");
  await sleep(400);
  await page.evaluate(() => document.querySelector("label[for=vmTable]").click());
  await sleep(1500);
  const tbl = await page.evaluate(() => ({
    rows: document.querySelectorAll("#tableWrap .tabulator-row").length,
    cols: [...document.querySelectorAll("#tableWrap .tabulator-col-title")]
      .map((c) => c.textContent.trim()),
    editionCell: (document.querySelector("#tableWrap .tabulator-row .tabulator-cell:nth-child(7)")
      || {}).textContent,
  }));
  check("table renders rows", tbl.rows > 10, tbl.rows + " rows");
  // Tabulator prefixes a header-menu glyph, so match loosely.
  check("table has Editions column",
    tbl.cols.some((c) => /Editions/.test(c)), tbl.cols.join(","));
  await page.screenshot({ path: OUT + "/04-table.png" });

  await page.evaluate(() => document.querySelector("label[for=vmCards]").click());
  await sleep(600);

  console.log("\n=== FAVORITES ===");
  await page.evaluate(() => document.querySelector("[data-fav]").click());
  await sleep(400);
  const favBadge = await page.evaluate(() => document.querySelector("#qvFav").textContent);
  await page.evaluate(() => [...document.querySelectorAll("[data-view]")]
    .find((b) => b.dataset.view === "favorites").click());
  await sleep(500);
  check("favorite saved and listed", favBadge === "1" && (await read()).n === 1, "badge " + favBadge);

  console.log("\n=== PREVIEW ===");
  await page.click("#resetAll");
  await sleep(400);
  await page.evaluate(() => document.querySelector("[data-preview]").click());
  await sleep(2500);
  const modal = await page.evaluate(() => ({
    shown: document.querySelector("#previewModal").classList.contains("show"),
    src: (document.querySelector("#previewBody iframe, #previewBody object") || {}).src ||
         (document.querySelector("#previewBody object") || {}).data || "",
    langBtns: [...document.querySelectorAll("#previewLangs button")].map((b) => b.textContent.trim()),
  }));
  check("preview opens a PDF", modal.shown && /\.pdf/i.test(modal.src));
  console.log("  preview language switcher: " + JSON.stringify(modal.langBtns));
  await page.screenshot({ path: OUT + "/05-preview.png" });
  await page.keyboard.press("Escape");
  await sleep(500);

  console.log("\n=== THEME / MOBILE ===");
  await page.click("#themeToggle");
  await sleep(400);
  await page.screenshot({ path: OUT + "/06-dark.png" });
  await page.setViewport({ width: 390, height: 844 });
  await sleep(700);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth + 2);
  check("no horizontal overflow on mobile", !overflow);
  await page.screenshot({ path: OUT + "/07-mobile.png" });

  console.log("\n=== CONSOLE ===");
  check("no console errors", errors.length === 0, errors.length + " errors");
  errors.slice(0, 10).forEach((e) => console.log("     - " + e.slice(0, 150)));

  console.log("\n" + (failures ? "FAILURES: " + failures : "ALL CHECKS PASSED"));
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("TEST CRASHED:", e); process.exit(1); });
