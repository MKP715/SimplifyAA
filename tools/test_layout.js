// Tests for the resizable sidebar and the cards-across / per-page controls.
//
//   node tools/test_layout.js http://127.0.0.1:8765/index.html
//
// Covers the drag handle (pointer drag, keyboard, clamping, persistence),
// column count, "Show all", and that the handle disappears when the layout
// stacks on a phone. Set CHROME_PATH for Chrome.

const puppeteer=require("puppeteer-core");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;
const check=(n,c,d)=>{console.log((c?"  PASS  ":"  FAIL  ")+n+(d?"  ["+d+"]":""));if(!c)fails++;};
const URL_ = process.argv[2] || "http://127.0.0.1:8765/index.html";
(async()=>{
 const b=await puppeteer.launch({executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",headless:"new",args:["--no-sandbox"]});
 const p=await b.newPage(); await p.setViewport({width:1500,height:1000});
 const errs=[]; p.on("pageerror",e=>errs.push(e.message));
 p.on("console",m=>{if(m.type()==="error")errs.push(m.text());});
 const ready=async()=>{await p.waitForFunction(()=>!/loading/i.test(document.querySelector("#resultCount").textContent),{timeout:45000});await sleep(700);};
 await p.goto(URL_,{waitUntil:"networkidle2"}); await ready();

 console.log("=== RESIZE HANDLE ===");
 const h=await p.evaluate(()=>{const e=document.querySelector("#resizeHandle");const cs=getComputedStyle(e);
   return {exists:!!e,display:cs.display,role:e.getAttribute("role"),tab:e.getAttribute("tabindex"),
           min:e.getAttribute("aria-valuemin"),now:e.getAttribute("aria-valuenow"),cursor:cs.cursor};});
 check("handle present and visible on a wide screen",h.exists&&h.display!=="none",h.display);
 check("handle is an accessible separator",h.role==="separator"&&h.tab==="0",h.role);
 check("handle reports its range",!!h.min&&!!h.now,"min="+h.min+" now="+h.now);
 check("handle shows a resize cursor",h.cursor==="col-resize",h.cursor);

 const widthOf=()=>p.evaluate(()=>Math.round(document.querySelector("#sidebarCol").getBoundingClientRect().width));
 const before=await widthOf();

 // drag it wider
 const box=await p.evaluate(()=>{const r=document.querySelector("#resizeHandle").getBoundingClientRect();
   return {x:r.x+r.width/2,y:r.y+80};});
 await p.mouse.move(box.x,box.y);
 await p.mouse.down();
 await p.mouse.move(box.x+140,box.y,{steps:12});
 await p.mouse.up();
 await sleep(600);
 const after=await widthOf();
 check("dragging widens the sidebar",after>before+80,before+"px -> "+after+"px");
 const saved=await p.evaluate(()=>JSON.parse(localStorage.getItem("simplifyaa.settings")||"{}").sidebarWidth);
 check("width is saved",saved>0,String(saved));

 await p.reload({waitUntil:"networkidle2"}); await ready();
 const restored=await widthOf();
 check("width survives a reload",Math.abs(restored-after)<6,restored+"px");

 // keyboard
 await p.evaluate(()=>document.querySelector("#resizeHandle").focus());
 await p.keyboard.press("ArrowLeft"); await sleep(300);
 const narrower=await widthOf();
 check("arrow keys resize it",narrower<restored,restored+" -> "+narrower);
 await p.keyboard.press("Home"); await sleep(400);
 const reset=await widthOf();
 check("Home resets to the default",Math.abs(reset-before)<8,reset+"px vs default "+before);

 // clamping
 await p.evaluate(()=>{const e=document.querySelector("#resizeHandle");e.focus();});
 for(let i=0;i<40;i++) await p.keyboard.press("ArrowLeft");
 await sleep(400);
 const min=await widthOf();
 check("cannot be dragged away entirely",min>=205,min+"px");

 console.log("\n=== CARDS ACROSS ===");
 const setSel=(sel,v)=>p.evaluate((s,val)=>{const n=document.querySelector(s);n.value=val;n.dispatchEvent(new Event("change"));},sel,v);
 const perRow=()=>p.evaluate(()=>{
   const cards=[...document.querySelectorAll("#cardsWrap > .col")];
   if(!cards.length) return 0;
   const top=Math.round(cards[0].getBoundingClientRect().top);
   return cards.filter(c=>Math.abs(Math.round(c.getBoundingClientRect().top)-top)<4).length;});
 check("options offered",await p.evaluate(()=>document.querySelectorAll("#colsSel option").length)===6,"");
 for(const n of ["1","2","4"]){
   await setSel("#colsSel",n); await sleep(700);
   const got=await perRow();
   check("choosing "+n+" puts "+n+" across",got===+n,"got "+got);
 }
 const savedCols=await p.evaluate(()=>JSON.parse(localStorage.getItem("simplifyaa.settings")||"{}").cols);
 check("cards-across is saved",savedCols==="4",String(savedCols));
 await p.reload({waitUntil:"networkidle2"}); await ready();
 check("cards-across survives a reload",(await perRow())===4,String(await perRow()));
 await setSel("#colsSel",""); await sleep(700);
 check("fit-the-window restores responsive columns",(await perRow())===3,String(await perRow()));

 console.log("\n=== SHOW ALL ===");
 await setSel("#pageSizeSel","0"); await sleep(1800);
 const all=await p.evaluate(()=>({cards:document.querySelectorAll("#cardsWrap .sa-card").length,
   pager:document.querySelectorAll("#pager li").length}));
 check("show all renders every result",all.cards>2000,all.cards+" cards");
 check("show all hides the pager",all.pager===0,all.pager+" pager items");
 await setSel("#pageSizeSel","12"); await sleep(900);
 check("12 per page works",(await p.evaluate(()=>document.querySelectorAll("#cardsWrap .sa-card").length))===12,"");

 console.log("\n=== NARROW SCREEN ===");
 await p.setViewport({width:390,height:844}); await sleep(800);
 const mob=await p.evaluate(()=>({handle:getComputedStyle(document.querySelector("#resizeHandle")).display,
   overflow:document.documentElement.scrollWidth>window.innerWidth+2}));
 check("handle hidden when stacked",mob.handle==="none",mob.handle);
 check("no horizontal overflow",!mob.overflow);

 const real=errs.filter(e=>!/Failed to fetch|net::ERR/.test(e));
 check("no console errors",real.length===0,real.length+"");
 real.slice(0,5).forEach(e=>console.log("     - "+e.slice(0,130)));
 await b.close();
 console.log("\n"+(fails?"FAILURES: "+fails:"ALL LAYOUT CHECKS PASSED"));
 process.exit(fails?1:0);
})().catch(e=>{console.error("CRASH",e);process.exit(1);});
