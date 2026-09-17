// Tests for the service-kit section of index.html.
//
//   node tools/test_kits.js http://127.0.0.1:8765/index.html
//
// Checks kit discovery, per-family grouping, workbook inclusion,
// print-only items, language switching and the reverse "in kits" badges.

const puppeteer = require("puppeteer-core");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (n, c, d) => { console.log((c?"  PASS  ":"  FAIL  ")+n+(d?"  ["+d+"]":"")); if(!c) fails++; };
(async () => {
  const b = await puppeteer.launch({executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",headless:"new",args:["--no-sandbox"]});
  const p = await b.newPage();
  await p.setViewport({width:1500,height:1100});
  const errors=[];
  p.on("console",m=>{if(m.type()==="error")errors.push(m.text());});
  p.on("pageerror",e=>errors.push("PAGEERROR: "+e.message));
  await p.goto(process.argv[2] || "http://127.0.0.1:8765/index.html",{waitUntil:"networkidle2"});
  await p.waitForFunction(()=>!/loading/i.test(document.querySelector("#resultCount").textContent),{timeout:40000});
  await sleep(800);

  const kitBtn = await p.evaluate(()=>{
    const b=document.querySelector('[data-view="kits"]');
    return {present:!!b, hidden:b?b.classList.contains("d-none"):true, badge:document.querySelector("#qvKits").textContent};
  });
  check("kits quick-view present", kitBtn.present && !kitBtn.hidden, "badge="+kitBtn.badge);
  check("start-here has kits door", await p.evaluate(()=>
    [...document.querySelectorAll("#startLinks button")].some(b=>/Service kits/.test(b.textContent))));

  // enter kits view
  await p.evaluate(()=>document.querySelector('[data-view="kits"]').click());
  await sleep(900);
  const v = await p.evaluate(()=>({
    heading: document.querySelector("#resultHeading").textContent.trim(),
    count: document.querySelector("#resultCount").textContent.trim(),
    kitsVisible: !document.querySelector("#kitsWrap").classList.contains("d-none"),
    cardsHidden: document.querySelector("#cardsWrap").classList.contains("d-none"),
    panels: document.querySelectorAll("#kitAcc .accordion-item").length,
    headers: [...document.querySelectorAll("#kitAcc .accordion-button")].map(h=>h.textContent.trim().replace(/\s+/g," ")),
    hash: location.hash,
  }));
  check("kits view renders", v.kitsVisible && v.cardsHidden, v.heading+" / "+v.count);
  check("all 12 kits listed", v.panels===12, v.panels+" panels");
  check("kits view is shareable", /view=kits/.test(v.hash), v.hash);
  console.log("  kits:"); v.headers.forEach(h=>console.log("     - "+h));

  // expand the treatment kit
  await p.evaluate(()=>{
    const h=[...document.querySelectorAll("#kitAcc .accordion-button")].find(x=>/Treatment/.test(x.textContent));
    h.click();
  });
  await sleep(900);
  const kit = await p.evaluate(()=>{
    const item=[...document.querySelectorAll("#kitAcc .accordion-item")].find(i=>/Treatment/.test(i.textContent));
    const body=item.querySelector(".accordion-body");
    return {
      groups: [...body.querySelectorAll(".text-uppercase")].map(g=>g.textContent.trim().replace(/\s+/g," ")),
      rows: body.querySelectorAll("li.list-group-item").length,
      links: body.querySelectorAll("li a[href*='.pdf']").length,
      printOnly: [...body.querySelectorAll("li")].filter(li=>/not published/.test(li.textContent)).length,
      hasWorkbook: /M-40I/.test(body.textContent),
      kitListBtn: !!body.querySelector("a.btn-primary[href*='.pdf']"),
      previewBtn: !!body.querySelector("[data-preview]"),
      langChips: [...body.querySelectorAll(".bi-translate")].length,
      firstItem: (body.querySelector("li a")||{}).textContent,
    };
  });
  console.log("  " + JSON.stringify(kit, null, 1).replace(/\n/g,"\n  "));
  check("kit groups contents by family", kit.groups.length>=4, kit.groups.join(" | "));
  check("kit lists all items", kit.rows>=45, kit.rows+" rows");
  check("kit items link to PDFs", kit.links>=35, kit.links+" links");
  check("workbook M-40I included", kit.hasWorkbook);
  check("print-only items marked", kit.printOnly>0, kit.printOnly+" print items");
  check("official kit list linked", kit.kitListBtn);
  check("kit list previewable", kit.previewBtn);

  await p.screenshot({path:"10-kits.png", fullPage:false});

  // search within kits
  await p.type("#q","corrections");
  await sleep(800);
  const s = await p.evaluate(()=>({
    panels: document.querySelectorAll("#kitAcc .accordion-item").length,
    count: document.querySelector("#resultCount").textContent.trim(),
  }));
  check("search filters kits", s.panels>0 && s.panels<12, s.panels+" kits | "+s.count);

  // language switch
  await p.evaluate(()=>{document.querySelector("#q").value="";document.querySelector("#q").dispatchEvent(new Event("input"))});
  await sleep(600);
  await p.evaluate(()=>{const b=[...document.querySelectorAll("#langGroup button")].find(x=>/Spanish/.test(x.textContent)); b.click();});
  await sleep(900);
  await p.evaluate(()=>{
    const h=[...document.querySelectorAll("#kitAcc .accordion-button")].find(x=>/Treatment|Tratamiento/.test(x.textContent));
    if(h) h.click();
  });
  await sleep(900);
  const es = await p.evaluate(()=>{
    const item=[...document.querySelectorAll("#kitAcc .accordion-item")].find(i=>/Treatment|Tratamiento/.test(i.textContent));
    if(!item) return {none:true};
    const body=item.querySelector(".accordion-body");
    const titles=[...body.querySelectorAll("li a")].map(a=>a.textContent.trim()).slice(0,4);
    return {kitUrl:(body.querySelector("a.btn-primary")||{}).href, titles};
  });
  console.log("  Spanish kit list URL: "+(es.kitUrl||"").slice(-46));
  console.log("  Spanish item titles: "+JSON.stringify(es.titles));
  check("kit list switches to Spanish edition", /sf-167|_sp|sp_/i.test(es.kitUrl||""), (es.kitUrl||"").slice(-40));
  check("kit contents shown in Spanish", (es.titles||[]).some(t=>/[áéíóúñ¿]|de |del |para /i.test(t)));
  await p.screenshot({path:"11-kits-es.png"});

  // reverse: kit badges on a document card
  await p.evaluate(()=>document.querySelector("#resetAll").click());
  await sleep(500);
  await p.type("#q","p-26");
  await sleep(800);
  const rev = await p.evaluate(()=>{
    const c=document.querySelector("#cardsWrap .sa-card");
    return {text:c?c.textContent.replace(/\s+/g," "):"", hasKits:/In kits:/.test(c?c.textContent:"")};
  });
  check("document shows which kits include it", rev.hasKits, rev.text.slice(0,120));

  check("no console errors", errors.length===0, errors.length+"");
  errors.slice(0,6).forEach(e=>console.log("     - "+e.slice(0,140)));
  console.log("\n"+(fails?"FAILURES: "+fails:"ALL KIT CHECKS PASSED"));
  await b.close();
  process.exit(fails?1:0);
})().catch(e=>{console.error("CRASH",e);process.exit(1);});
