// Tests for the Spanish and French interface, and for searching by subject.
//
//   node tools/test_i18n.js http://127.0.0.1:8765/index.html
//
// Checks that switching language translates the chrome, the taxonomy and the
// prose blocks, that switching between two non-English languages and back to
// English works (translation must not be destructive), that the choice
// persists, and that aa.org summaries feed search. Set CHROME_PATH for Chrome.

const puppeteer=require("puppeteer-core");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;
const check=(n,c,d)=>{console.log((c?"  PASS  ":"  FAIL  ")+n+(d?"  ["+d+"]":""));if(!c)fails++;};
(async()=>{
 const b=await puppeteer.launch({executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",headless:"new",args:["--no-sandbox"]});
 const p=await b.newPage(); await p.setViewport({width:1500,height:1000});
 const errs=[]; p.on("pageerror",e=>errs.push(e.message));
 p.on("console",m=>{if(m.type()==="error")errs.push(m.text());});
 const ready=async()=>{await p.waitForFunction(()=>!/loading/i.test(document.querySelector("#resultCount").textContent),{timeout:45000});await sleep(900);};
 await p.goto(process.argv[2] || "http://127.0.0.1:8765/index.html",{waitUntil:"networkidle2"}); await ready();

 console.log("=== DEFAULT (English) ===");
 let v=await p.evaluate(()=>({sel:document.querySelector("#uiLangSel").value,
   lang:document.documentElement.lang,
   search:document.querySelector('label[for="q"]').textContent.trim(),
   quick:document.querySelector('[data-view="all"]').textContent.trim()}));
 check("defaults to English",v.sel==="en"&&v.lang==="en",v.sel+"/"+v.lang);
 check("English labels intact",/Search/.test(v.search),v.search);

 for (const [code,probe,heading] of [["es","Buscar","Todos los documentos"],["fr","Rechercher","Tous les documents"]]) {
   console.log("\n=== "+code.toUpperCase()+" ===");
   await p.evaluate((c)=>{const s=document.querySelector("#uiLangSel");s.value=c;s.dispatchEvent(new Event("change"));},code);
   await sleep(1800);
   v=await p.evaluate(()=>({
     lang:document.documentElement.lang,
     search:document.querySelector('label[for="q"]').textContent.trim(),
     quickAll:document.querySelector('[data-view="all"]').textContent.trim(),
     sortOpt:[...document.querySelectorAll("#sortSel option")].map(o=>o.textContent.trim()).slice(0,3),
     sections:[...document.querySelectorAll("#tree .accordion-button")].map(x=>x.textContent.trim().replace(/\s+/g," ")).slice(0,4),
     topics:[...document.querySelectorAll("#topics .sa-chip")].map(x=>x.textContent.trim()).slice(0,3),
     langBtns:[...document.querySelectorAll("#langGroup button")].map(x=>x.textContent.trim()),
     count:document.querySelector("#resultCount").textContent.trim(),
     cardBtn:(document.querySelector("#cardsWrap .btn-primary")||{}).textContent,
     start:document.querySelector("#startHere .fw-semibold")?document.querySelector("#startHere").textContent.slice(0,40):"",
   }));
   check("html lang set",v.lang===code,v.lang);
   check("sidebar translated",v.search===probe,v.search);
   check("quick view translated",new RegExp(heading.split(" ")[0]).test(v.quickAll),v.quickAll);
   check("sort options translated",!/Best match/.test(v.sortOpt.join("|")),v.sortOpt.join(" | "));
   check("sections translated",!/Newsletters$/.test(v.sections[0]||""),(v.sections[0]||"").slice(0,32));
   check("topics translated",v.topics.length>0,(v.topics[0]||"").slice(0,26));
   check("language filter translated",!/English/.test(v.langBtns.join("|")),v.langBtns.join(" | ").slice(0,44));
   check("count line translated",!/documents of/.test(v.count),v.count);
   check("card buttons translated",v.cardBtn&&!/Open/.test(v.cardBtn),(v.cardBtn||"").trim());
   // about modal block swap
   await p.evaluate(()=>bootstrap.Modal.getOrCreateInstance(document.querySelector("#aboutModal")).show());
   await sleep(900);
   const about=await p.evaluate(()=>({title:document.querySelector("#aboutModal .modal-title").textContent.trim(),
     body:document.querySelector('[data-i18n-block="about"]').textContent.replace(/\s+/g," ").slice(0,70)}));
   check("About modal translated",!/About this index/.test(about.title),about.title);
   check("About prose translated",!/^Unofficial\./.test(about.body),about.body.slice(0,56));
   await p.evaluate(()=>bootstrap.Modal.getInstance(document.querySelector("#aboutModal")).hide());
   await sleep(700);
   await p.screenshot({path:process.env.SHOTS+"/60-"+code+".png"});
 }

 console.log("\n=== PERSISTS + BACK TO ENGLISH ===");
 await p.reload({waitUntil:"networkidle2"}); await ready();
 check("choice persists",await p.evaluate(()=>document.querySelector("#uiLangSel").value)==="fr","");
 await p.evaluate(()=>{const s=document.querySelector("#uiLangSel");s.value="en";s.dispatchEvent(new Event("change"));});
 await sleep(1500);
 v=await p.evaluate(()=>({search:document.querySelector('label[for="q"]').textContent.trim(),
   about:(document.querySelector('[data-i18n-block="about"]')||{}).textContent||""}));
 check("switching back restores English",v.search==="Search",v.search);
 check("prose block restored",/Unofficial/.test(v.about.slice(0,200)),v.about.replace(/\s+/g," ").slice(0,40));

 console.log("\n=== SUMMARY IN SEARCH ===");
 await p.evaluate(()=>{const q=document.querySelector("#q");q.value="anonymity safeguard";q.dispatchEvent(new Event("input"));});
 await sleep(1200);
 const sres=await p.evaluate(()=>({n:document.querySelector("#resultCount").textContent.trim(),
   sums:document.querySelectorAll("#cardsWrap .sa-summary").length,
   first:(document.querySelector("#cardsWrap .sa-card-title")||{}).textContent,
   sort:document.querySelector("#sortSel").value}));
 check("summaries shown on cards",sres.sums>0,sres.sums+" summaries");
 check("subject search finds something",/^[1-9]/.test(sres.n),sres.n);
 check("searching switches to Best match",sres.sort==="relevance",sres.sort);
 console.log("   first hit: "+(sres.first||"").trim().slice(0,60));

 const real=errs.filter(e=>!/Failed to fetch|net::ERR/.test(e));
 check("no console errors",real.length===0,real.length+"");
 real.slice(0,6).forEach(e=>console.log("     - "+e.slice(0,140)));
 await b.close();
 console.log("\n"+(fails?"FAILURES: "+fails:"ALL I18N CHECKS PASSED"));
 process.exit(fails?1:0);
})().catch(e=>{console.error("CRASH",e);process.exit(1);});
