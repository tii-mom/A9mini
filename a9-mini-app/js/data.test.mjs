import test from 'node:test';
import assert from 'node:assert/strict';
const storage=()=>({getItem:()=>null,setItem(){},removeItem(){}});
globalThis.localStorage=storage();globalThis.sessionStorage=storage();
globalThis.window={location:new URL('http://localhost/?mode=live&timeout=200'),__A9_CONFIG__:{network:'testnet'},Telegram:{WebApp:{initData:'x'.repeat(40)+'A'}},matchMedia:()=>({matches:false})};
globalThis.document={documentElement:{dataset:{}},querySelector:()=>null,getElementById:()=>null};
const {fetchMe,requestTonProofPayload}=await import('./data.js');
const reply=()=>({status:200,json:async()=>({ok:true,data:{valid:true}})});

test('real request layer deduplicates reads, isolates complete identity, retries failures, and never merges writes',async()=>{
 let calls=[];let release;const resolvers=[];
 globalThis.fetch=(url,options)=>{calls.push({url,options});return new Promise(r=>{release=r;resolvers.push(r)})};
 const a=fetchMe(),b=fetchMe();assert.equal(calls.length,1);release(reply());assert.deepEqual(await a,await b);
 const c=fetchMe();assert.equal(calls.length,2);
 window.Telegram.WebApp.initData='x'.repeat(40)+'B';const d=fetchMe();assert.equal(calls.length,3,'identities sharing a prefix must remain separate');
 resolvers[1](reply());resolvers[2](reply());await Promise.all([c,d]);
 window.Telegram.WebApp.initData='retry-user';let tries=0;
 globalThis.fetch=async()=>{tries++;if(tries===1)throw Error('offline');return reply()};
 await assert.rejects(fetchMe(),{code:'NETWORK'});assert.deepEqual(await fetchMe(),{valid:true});assert.equal(tries,2);
 let writes=0;globalThis.fetch=async()=>{writes++;return reply()};await Promise.all([requestTonProofPayload(),requestTonProofPayload()]);assert.equal(writes,2);
});


test('timeout and server rejection release the real in-flight entry', async () => {
 window.Telegram.WebApp.initData='timeout-user';
 let calls=0;
 globalThis.fetch=(_url,{signal})=>{calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))};
 await assert.rejects(fetchMe(),e=>e.code==='NETWORK'&&e.status===408);
 globalThis.fetch=async()=>{calls++;return {status:503,json:async()=>({ok:false,error:{code:'UNAVAILABLE',message:'retry'}})}};
 await assert.rejects(fetchMe(),{code:'UNAVAILABLE'});
 globalThis.fetch=async()=>{calls++;return reply()};
 await fetchMe();assert.equal(calls,3);
});
