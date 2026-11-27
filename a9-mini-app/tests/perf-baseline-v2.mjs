/** Reproducible browser measurements. No credentials or wallet sessions are fabricated. */
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const modulePath=process.env.PLAYWRIGHT_MODULE || 'playwright';
export const conditions={viewport:{width:390,height:844},locale:'zh-CN',theme:'light',cpu:4,network:{offline:false,downloadThroughput:1250000,uploadThroughput:625000,latency:100}};
export async function launch(){const {chromium}=await import(modulePath);return chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true});}
export async function measure(page,url,{timeout=30000,tabs=[],warmTabs=false,throttle=true}={}){
 const errors=[];const listener=e=>errors.push(e.message);page.on('pageerror',listener);
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Network.enable');
 if(throttle){await cdp.send('Network.emulateNetworkConditions',conditions.network);await cdp.send('Emulation.setCPUThrottlingRate',{rate:conditions.cpu});}
 await page.addInitScript(()=>{
  window.__perf={lcp:null,cls:0,longTasks:0};
  localStorage.setItem('a9_ui_prefs_v1',JSON.stringify({settings:{language:'zh-CN',themeMode:'light'}}));
  for(const type of ['largest-contentful-paint','layout-shift','longtask']){
   if(!PerformanceObserver.supportedEntryTypes.includes(type))continue;
   new PerformanceObserver(list=>{for(const e of list.getEntries()){if(type==='largest-contentful-paint')window.__perf.lcp=e.startTime;else if(type==='layout-shift'&&!e.hadRecentInput)window.__perf.cls+=e.value;else if(type==='longtask')window.__perf.longTasks++;}}).observe({type,buffered:true});
  }
 });
 try{
  await page.goto(url,{waitUntil:'domcontentloaded',timeout});
  await page.waitForFunction(()=>{
   const host=document.querySelector('#app-main .route-view-host');
   const hasData=!!document.querySelector('.plaza-overview,.card-hero,#round-price-arena,.sw-profile-asset-card,#profile-asset-card');
   return host&&host.getAttribute('aria-busy')!=='true'&&host.textContent.trim()&&hasData&&!document.querySelector('.nt-boot-skeleton,.data-error-card')&&Array.from(document.querySelectorAll('link[rel=stylesheet]')).every(l=>!!l.sheet);
  },null,{timeout});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const ready=await page.evaluate(()=>performance.now());
  const switchRoute=async hash=>{
   const start=await page.evaluate(()=>{window.__perfPreviousHost=document.querySelector('#app-main .route-view-host');return performance.now()});
   await page.evaluate(h=>{window.location.hash=h},hash);
   await page.waitForFunction(h=>location.hash===h&&document.querySelector('#app-main .route-view-host')!==window.__perfPreviousHost&&document.querySelector('#app-main .route-view-host')?.textContent.trim()&&!document.querySelector('.nt-boot-skeleton'),hash,{timeout});
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   return {hash,ms:await page.evaluate(s=>performance.now()-s,start)};
  };
  const metrics=await page.evaluate(()=>{
   const res=performance.getEntriesByType('resource').map(r=>({path:new URL(r.name).pathname,transfer:r.transferSize,decoded:r.decodedBodySize}));
   const sum=ext=>res.filter(r=>r.path.endsWith(ext)).reduce((a,r)=>a+r.decoded,0);
   return {...window.__perf,fcp:performance.getEntriesByName('first-contentful-paint')[0]?.startTime??null,jsDecoded:sum('.js'),cssDecoded:sum('.css'),resources:res};
  });
  if(warmTabs)for(const tab of tabs)await switchRoute(tab);
  const timings=[];for(const tab of tabs)timings.push(await switchRoute(tab));
  return {...metrics,ready,timings,errors};
 }finally{page.off('pageerror',listener);await cdp.detach();}
}
export function summarize(samples){
 if(samples.length!==5||samples.some(s=>s.error||s.errors?.length||!Number.isFinite(s.ready)))throw Error('Exactly five valid samples are required');
 const stat=k=>{const v=samples.map(s=>s[k]).filter(Number.isFinite).sort((a,b)=>a-b);return v.length?{median:v[Math.floor(v.length/2)],min:v[0],max:v.at(-1)}:null};
 return {runs:5,ready:stat('ready'),fcp:stat('fcp'),lcp:stat('lcp'),jsDecoded:stat('jsDecoded'),cssDecoded:stat('cssDecoded')};
}
export async function main(){
 const base=process.env.A9_PERF_URL || 'http://127.0.0.1:8091';const revision=process.env.A9_PERF_REVISION;if(!revision)throw Error('A9_PERF_REVISION (source fingerprint) is required');
 const out=process.env.A9_PERF_OUTPUT || '/tmp/a9-perf-results';await mkdir(out,{recursive:true});const browser=await launch();const scenarios=[];
 try{for(const id of ['live-cold','live-warm','demo-cold','tab-first','tab-cached','telegram-fragment']){
  const samples=[];let shared;
  if(id==='live-warm'){shared=await browser.newContext({viewport:conditions.viewport,locale:conditions.locale,colorScheme:'light'});const p=await shared.newPage();await measure(p,base+'/?mode=live#/challenge');await p.close();}
  try{for(let i=0;i<5;i++){
   const ctx=shared||await browser.newContext({viewport:conditions.viewport,locale:conditions.locale,colorScheme:'light'});const page=await ctx.newPage();
   try{samples.push(await measure(page,base+(id==='telegram-fragment'?'/?mode=demo#tgWebAppData=fixture&tgWebAppVersion=9.6':`/?mode=${id.startsWith('live')?'live':'demo'}#/challenge`),{tabs:id.startsWith('tab')?['#/round','#/team','#/profile','#/challenge']:[],warmTabs:id==='tab-cached'}));}
   catch(e){samples.push({error:e.message});}finally{await page.close();if(!shared)await ctx.close();}
  }}finally{await shared?.close();}
  let summary;try{summary=summarize(samples);}catch(e){summary={error:e.message};}
  scenarios.push({id,samples,summary});console.log(id,JSON.stringify(summary));
 }}finally{await browser.close();}
 const report={base,revision,conditions,createdAt:new Date().toISOString(),scenarios,limitations:['No real wallet session measured','Cross-origin zero transferSize is unavailable, not zero bytes','LCP observation ends at measurement checkpoint','Telegram fragment uses a synthetic launch envelope, not native authentication']};
 const file=out+'/baseline-'+revision+'.json';await writeFile(file,JSON.stringify(report,null,2));if(scenarios.some(s=>s.summary.error))throw Error('Baseline failed; evidence saved to '+file);return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1});
