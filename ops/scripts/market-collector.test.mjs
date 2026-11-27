import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {collectMarketOnce} from './lib/market-collector.mjs';
import {MarketSampleArchive,buildSettlementInputBundle,verifySettlementInputBundle,fetchRealProviderSamples,createRecentPoll} from './lib/market-oracle.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/market-provider-sanitized-fixture.json',import.meta.url)));
const binding=fixture.binding;
const start=1795700000;
function feed(ts=start-60) {
  const item=structuredClone(fixture.trades.data[0]);
  item.attributes.block_timestamp=new Date(ts*1000).toISOString();
  return {data:[item]};
}
function network(trades=feed()) {
  return async url=>({ok:true,status:200,json:async()=>url.includes('api.ston.fi')?fixture.poolMetadata:trades});
}
function temp(fn){return async()=>{const d=mkdtempSync(join(tmpdir(),'a9-collector-'));try{await fn(d)}finally{rmSync(d,{recursive:true,force:true})}}}

test('real adapter → archive → restart → 12H simulated observations → bundle → CLI replay, no manual field repair',temp(async d=>{
  const path=join(d,'archive.json');
  for(let i=0;i<24;i++) {
    const r=await collectMarketOnce({archivePath:path,binding,...(i===0?{start}:{}),nowSec:start+(i+1)*1800,settlementLagSeconds:0,fetchImpl:network()});
    assert.equal(r.ok,true);
  }
  const archive=new MarketSampleArchive(path,binding).load();
  assert.equal(archive.coverageSegments.length,24);
  const b=buildSettlementInputBundle({roundId:1,targetPriceUsdE8:'174000',stakeCloseAt:start,binding,...archive});
  assert.equal(verifySettlementInputBundle(b,binding).ok,true);
  const file=join(d,'bundle.json');writeFileSync(file,JSON.stringify(b));
  const cli=spawnSync(process.execPath,['ops/scripts/market-feed.mjs','--action','verify-settle','--profile','mainnet','--input',file],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);
  assert.match(cli.stdout,/"ok": true/);
  const before=readFileSync(path,'utf8');
  const last=archive.coverageSegments.at(-1);
  new MarketSampleArchive(path,binding).appendPoll(last);
  assert.equal(readFileSync(path,'utf8'),before,'identical poll replay is idempotent');
}));

test('short recent response without start anchor is not exhausted history; empty response is not no-trades',temp(async d=>{
  for(const trades of [feed(start+10),{data:[]}]) {
    await assert.rejects(()=>collectMarketOnce({archivePath:join(d,'a.json'),binding,start,nowSec:start+1800,settlementLagSeconds:0,fetchImpl:network(trades)}),/TRUNCATED|EMPTY_RECENT/);
  }
  assert.equal(readdirSync(d).includes('a.json'),false);
}));

test('restart across outage, concurrent writer and provider failure leave accepted archive unchanged',temp(async d=>{
  const path=join(d,'a.json');
  await collectMarketOnce({archivePath:path,binding,start,nowSec:start+1800,settlementLagSeconds:0,fetchImpl:network()});
  const before=readFileSync(path,'utf8');
  await assert.rejects(()=>collectMarketOnce({archivePath:path,binding,nowSec:start+9000,settlementLagSeconds:0,fetchImpl:network()}),/INTERVAL_UNPROVEN/);
  writeFileSync(path+'.collect.lock','held');
  await assert.rejects(()=>collectMarketOnce({archivePath:path,binding,fetchImpl:network()}),/COLLECTOR_LOCKED/);
  rmSync(path+'.collect.lock');
  await assert.rejects(()=>collectMarketOnce({archivePath:path,binding,maxAttempts:1,fetchImpl:async()=>({ok:false,status:503})}),/HTTP 503/);
  assert.equal(readFileSync(path,'utf8'),before);
}));

test('captured response rejects reused time range, endpoint substitution and disabled pool verification',async()=>{
  const r=await fetchRealProviderSamples({binding,nowSec:start+1800,fetchImpl:network()});
  assert.throws(()=>createRecentPoll(r,{start,end:start+1801}),/CAPTURE_TIME/);
  const tampered=structuredClone(r);tampered.rawPayload.capture.tradesUrl='https://example.com/trades';
  assert.throws(()=>createRecentPoll(tampered,{start}),/ENDPOINT_MISMATCH/);
  await assert.rejects(()=>fetchRealProviderSamples({binding,verifyPool:false}),/POOL_VERIFICATION_REQUIRED/);
});

test('irrelevant old timestamp collisions do not block capture; in-window ambiguity still fails closed',temp(async d=>{
  const make=(ts,price,id)=>{const x=structuredClone(fixture.trades.data[0]);x.attributes.block_timestamp=new Date(ts*1000).toISOString();x.attributes.price_to_in_usd=price;x.attributes.tx_hash=id;return x;};
  const old=[make(start-120,'0.001','one'),make(start-120,'0.002','two'),make(start-10,'0.003','anchor')];
  const path=join(d,'a.json');
  await collectMarketOnce({archivePath:path,binding,start,nowSec:start+1800,settlementLagSeconds:0,fetchImpl:network({data:old})});
  const before=readFileSync(path,'utf8');
  await assert.rejects(()=>collectMarketOnce({archivePath:path,binding,start:start+1799,nowSec:start+3600,settlementLagSeconds:0,fetchImpl:network({data:[...old,make(start+2000,'0.004','three'),make(start+2000,'0.005','four')]})}),/conflicting prices/);
  assert.equal(readFileSync(path,'utf8'),before);
}));
