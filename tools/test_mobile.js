// Mobile layout tests, and a guard that the phone work has not leaked into
// the desktop layout.
//
//   node tools/test_mobile.js http://127.0.0.1:8765/index.html
//
// The measurements matter as much as the assertions: it was a page-height and
// touch-target count that revealed a first visit rendering all 2,919
// documents, which every functional suite had happily passed.
// Set CHROME_PATH for Chrome, SHOTS for screenshots.

const puppeteer = require("puppeteer-core");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_ = process.argv[2] || "http://127.0.0.1:8765/index.html";
const SHOTS = process.env.SHOTS || ".";
let fails = 0;
const check = (n, c, d) => {
  console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? "  [" + d + "]" : ""));
  if (!c) fails++;
};

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const AND_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

const PHONES = [
  { name: "iPhone SE", w: 320, h: 568, ua: IOS_UA },
  { name: "Android compact", w: 360, h: 740, ua: AND_UA },
  { name: "iPhone 14", w: 390, h: 844, ua: IOS_UA },
  { name: "iPhone Plus", w: 428, h: 926, ua: IOS_UA },
];

async function open(browser, d) {
  const p = await browser.newPage();
  if (d.ua) await p.setUserAgent(d.ua);
  await p.setViewport({ width: d.w, height: d.h, isMobile: !!d.ua, hasTouch: !!d.ua,
                        deviceScaleFactor: d.ua ? 3 : 1 });
  await p.goto(URL_, { waitUntil: "networkidle2" });
  await p.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent),
    { timeout: 45000 });
  await sleep(900);
  return p;
}

const layout = (p) => p.evaluate(() => {
  const cs = (s, prop) => {
    const e = document.querySelector(s);
    return e ? getComputedStyle(e)[prop] : "missing";
  };
  const card = document.querySelector("#cardsWrap .sa-card");
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    firstCardTop: card ? Math.round(card.getBoundingClientRect().top + window.scrollY) : -1,
    screens: card
      ? +((card.getBoundingClientRect().top + window.scrollY) / window.innerHeight).toFixed(2)
      : -1,
    docHeight: document.documentElement.scrollHeight,
    cards: document.querySelectorAll("#cardsWrap .sa-card").length,
    mobileBar: cs("#mobileBar", "display"),
    bottomBar: cs("#bottomBar", "display"),
    drawerPosition: cs("#sidebarPanel", "position"),
    resizeHandle: cs("#resizeHandle", "display"),
    startWrap: cs("#startLinks", "flexWrap"),
    bodyPadBottom: cs("body", "paddingBottom"),
    sidebarHeight: (() => {
      const a = document.querySelector("#sidebarCol");
      return a ? Math.round(a.getBoundingClientRect().height) : -1;
    })(),
  };
});

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: "new", args: ["--no-sandbox"],
  });

  console.log("=== VIEWPORT ===");
  let p = await open(browser, PHONES[2]);
  const vp = await p.evaluate(() =>
    (document.querySelector('meta[name="viewport"]') || {}).content || "");
  check("viewport allows drawing into the safe area",
    /viewport-fit=cover/.test(vp), vp);
  await p.close();

  for (const d of PHONES) {
    console.log("\n=== " + d.name + " " + d.w + "x" + d.h + " ===");
    p = await open(browser, d);
    const m = await layout(p);
    console.log("      first result at " + m.firstCardTop + "px (" + m.screens +
      " screens) | page " + m.docHeight + "px | " + m.cards + " cards");

    check("no horizontal overflow", m.overflow <= 2, m.overflow + "px");
    check("results reachable without a screenful of filters",
      m.screens >= 0 && m.screens < 1, m.screens + " screens");
    check("sidebar is a drawer, out of the flow",
      m.drawerPosition === "fixed" && m.sidebarHeight <= 2,
      m.drawerPosition + ", column " + m.sidebarHeight + "px");
    check("sticky search bar present", m.mobileBar === "block", m.mobileBar);
    check("bottom action bar present", m.bottomBar === "flex", m.bottomBar);
    check("resize handle hidden when stacked", m.resizeHandle === "none", m.resizeHandle);
    check("shortcuts row is one swipeable line", m.startWrap === "nowrap", m.startWrap);
    check("content clears the fixed bottom bar",
      parseFloat(m.bodyPadBottom) > 40, m.bodyPadBottom);
    check("results are paged, not all rendered", m.cards === 48, m.cards + " cards");

    // Bottom bar targets must be thumb-sized.
    const targets = await p.evaluate(() =>
      [...document.querySelectorAll("#bottomBar .sa-bottom-btn")].map((b) => {
        const r = b.getBoundingClientRect();
        return { label: (b.textContent || "").trim(), h: Math.round(r.height),
                 w: Math.round(r.width) };
      }));
    check("bottom bar targets are at least 44px tall",
      targets.length > 0 && targets.every((t) => t.h >= 44),
      targets.map((t) => t.label + " " + t.w + "x" + t.h).join(", "));

    // The drawer must open, and close again after picking something.
    const drawer = await p.evaluate(async () => {
      document.querySelector("#mobileBar [data-bs-target='#sidebarPanel']").click();
      await new Promise((r) => setTimeout(r, 700));
      const panel = document.querySelector("#sidebarPanel");
      const shown = panel.classList.contains("show");
      const searchReachable = !!document.querySelector("#sidebarPanel #q");
      // Pick the first quick view, which should reveal the results.
      document.querySelector("#sidebarPanel [data-view='recent']").click();
      await new Promise((r) => setTimeout(r, 900));
      return { shown, searchReachable,
               closed: !document.querySelector("#sidebarPanel").classList.contains("show") };
    });
    check("drawer opens from the sticky bar", drawer.shown);
    check("the full sidebar is inside the drawer", drawer.searchReachable);
    check("drawer closes once a view is chosen", drawer.closed);

    if (d.w === 390) {
      await p.evaluate(() => document.querySelector("#homeLink").click());
      await sleep(700);
      await p.screenshot({ path: SHOTS + "/72-mobile-after.png" });
    }
    await p.close();
  }

  // ---- the part that matters most: desktop must be untouched ----
  for (const w of [1500, 1200, 992]) {
    console.log("\n=== DESKTOP " + w + "px (must be unchanged) ===");
    p = await open(browser, { w: w, h: 950 });
    const m = await layout(p);
    check("no phone search bar", m.mobileBar === "none", m.mobileBar);
    check("no bottom bar", m.bottomBar === "none", m.bottomBar);
    check("sidebar sits inline, not as a drawer",
      m.drawerPosition === "static" && m.sidebarHeight > 200,
      m.drawerPosition + ", " + m.sidebarHeight + "px");
    check("resize handle available", m.resizeHandle === "flex", m.resizeHandle);
    check("shortcuts still wrap", m.startWrap === "wrap", m.startWrap);
    check("no padding reserved for a bar that is not there",
      parseFloat(m.bodyPadBottom) === 0, m.bodyPadBottom);
    check("heading and count still shown", await p.evaluate(() =>
      getComputedStyle(document.querySelector("#results > .sa-panel .me-auto")).display
        !== "none"));
    check("Filters button still shown", await p.evaluate(() =>
      getComputedStyle(document.querySelector("#filterToggle")).display !== "none"));
    check("no horizontal overflow", m.overflow <= 2, m.overflow + "px");
    await p.close();
  }

  await browser.close();
  console.log("\n" + (fails ? "FAILURES: " + fails : "ALL MOBILE CHECKS PASSED"));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
