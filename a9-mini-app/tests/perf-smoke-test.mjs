import assert from 'node:assert/strict';
import http from 'node:http';
import {launch,measure,summarize} from './perf-baseline-v2.mjs';
import {compare} from './perf-compare-v2.mjs';
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const delay=Number(url.searchParams.get('delay')||0);
 res.setHeader('Content-Type','text/html');
 res.end(`<main id="app-main"></main><script>
 ${url.searchParams.has('error')?"setTimeout(()=>{throw Error('fixture-error')},0);":''}
 ${url.searchParams.has('never')?'':`setTimeout(()=>document.querySelector('main').innerHTML='<div class="route-view-host"><div class="plaza-overview">Ready</div></div>',${delay});`}
 </script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await launch();const context=await browser.newContext();
try{
 const base=`http://127.0.0.1:${server.address().port}`;
 const run=async suffix=>{const p=await context.newPage();try{return await measure(p,base+suffix,{timeout:1500,throttle:false})}finally{await p.close()}};
 const fast=await run('/');const slow=await run('/?delay=650');assert.ok(slow.ready-fast.ready>450);
 await assert.rejects(run('/?never'),/Timeout/);
 const broken=await run('/?error&delay=100');assert.ok(broken.errors.some(e=>e.includes('fixture-error')));
 assert.throws(()=>summarize([fast]),/five valid/);
 assert.throws(()=>summarize(Array(5).fill(broken)),/five valid/);
 assert.throws(()=>compare({base:'a'},{base:'b'}));
 console.log('PASS: actual measurement detects delay, timeout, page errors, insufficient samples and incompatible comparisons');
}finally{await context.close();await browser.close();await new Promise(r=>server.close(r))}
