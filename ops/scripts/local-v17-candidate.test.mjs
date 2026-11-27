import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { startLocalCandidate, resolveLocalDataDir } from './local-v17-candidate.mjs';
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
test('local candidate isolates persistent D1, applies all migrations, fails closed and delivers real assets',async()=>{
 const dir=await mkdtemp(resolve(tmpdir(),'a9-v17-candidate-test-'));
 let instance;
 try{
  const port=await freePort();instance=await startLocalCandidate({port,dataDir:dir});
  const get=p=>fetch(instance.origin+p);
  let response=await get('/__candidate/status');let status=await response.json();
  assert.equal(status.network,'testnet');assert.equal(status.migrations.length,15);assert.equal(status.chainConnected,false);
  assert.equal(status.liveFundsEnabled,false);assert.equal(status.outboundNetwork,'denied');assert.equal(status.secretsConfigured,false);
  response=await get('/api/config');assert.equal(response.status,503);assert.equal((await response.json()).error.code,'CANDIDATE_CONFIG_INCOMPLETE');
  response=await fetch(instance.origin+'/api/presale/intent',{method:'POST',body:'{}'});assert.equal(response.status,403);
  response=await get('/js/runtime-config.js');const runtimeCfg=await response.text();assert.match(runtimeCfg,/"network":"testnet"/);
  // 候选 runtime-config 必须显式注入测试 Bot 句柄，且资金总闸保持关闭
  assert.match(runtimeCfg,/"botHandle":"A9_TestnetBot"/);assert.match(runtimeCfg,/"liveFundsEnabled":false/);assert.match(runtimeCfg,/"lockMode":true/);
  response=await get('/js/demo-loader.js');assert.match(response.headers.get('content-type'),/javascript/);
  response=await get('/js/missing.js');assert.equal(response.status,404);
  response=await get('/');assert.match(await response.text(),/本地隔离候选/);
  await assert.rejects(startLocalCandidate({port:await freePort(),dataDir:dir}),/already running/);
  await instance.stop();instance=null;
  instance=await startLocalCandidate({port:await freePort(),dataDir:dir});assert.equal(instance.status.migrations.length,15);
 }finally{if(instance)await instance.stop();await rm(dir,{recursive:true,force:true});}
});
test('local storage may not point at project or production-shaped directories',()=>{
 assert.throws(()=>resolveLocalDataDir(process.cwd()),/dedicated/);
 assert.throws(()=>resolveLocalDataDir('/tmp/production'),/dedicated/);
});
