#!/usr/bin/env node
// Local-only workerd/D1 candidate. No credentials, wallet access or outbound network.
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, open, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyV15Artifacts, V17_ROOT } from './lib/v15-core.mjs';
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const appRoot = resolve(root, 'a9-mini-app');
const migrationRoot = resolve(root, 'worker/migrations');
const mainFile = fileURLToPath(import.meta.url);

export function localRuntimeConfig(port) {
  // 候选 runtime-config 必须显式注入测试 Bot 句柄，钱包回跳才不会回落到正式 Bot。
  return { mode: 'live', lockMode: true, network: 'testnet', apiBase: `http://127.0.0.1:${port}`, liveFundsEnabled: false, botHandle: 'A9_TestnetBot' };
}
export function resolveLocalDataDir(path) {
  const out = resolve(path);
  if (out === root || out.startsWith(root + sep) || !out.includes('a9-v17-candidate')) throw new Error('Use a dedicated a9-v17-candidate directory outside the repository');
  return out;
}
function runtimePackage(name, override) {
  if (override) return require(override);
  try { return require(name); } catch {}
  const cache = resolve(homedir(), '.npm/_npx');
  const found = [];
  if (existsSync(cache)) for (const folder of require('node:fs').readdirSync(cache)) {
    const path = resolve(cache, folder, 'node_modules', name, 'package.json');
    if (!existsSync(path)) continue;
    const info = JSON.parse(readFileSync(path, 'utf8'));
    if (!info.version.includes('-')) found.push({ version: info.version, path: dirname(path) });
  }
  found.sort((a,b)=>b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (!found.length) throw new Error(`Install ${name} or supply its module path; no automatic installation is performed`);
  return require(found[0].path);
}
const MIME = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2' };
export async function startLocalCandidate({ port = 8097, dataDir = resolve(homedir(), '.local/share/a9-v17-candidate'), miniflareModule, esbuildModule } = {}) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
  dataDir = resolveLocalDataDir(dataDir);
  verifyV15Artifacts(V17_ROOT);
  await mkdir(dataDir, { recursive:true, mode:0o700 });
  const lockPath = resolve(dataDir, 'local-candidate.lock');
  const lock = await open(lockPath,'wx',0o600).catch(()=>{throw new Error('Candidate already running or stale local lock; inspect before removing it');});
  let mf, server;
  const stop = async()=>{try{if(server?.listening)await new Promise(r=>server.close(r));if(mf)await mf.dispose();}finally{await lock.close().catch(()=>{});await unlink(lockPath).catch(()=>{});}};
  try {
    const mfRuntime = runtimePackage('miniflare', miniflareModule);
    const { Miniflare } = mfRuntime;
    const { build } = runtimePackage('esbuild', esbuildModule);
    const buildResult = await build({ entryPoints:[resolve(root,'worker/src/cf-worker.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*'],write:false,logLevel:'silent' });
    const origin = `http://127.0.0.1:${port}`;
    const mfOptions = { modules:true,script:buildResult.outputFiles[0].text,compatibilityDate:'2026-11-01',compatibilityFlags:['nodejs_compat'],
      d1Databases:{DB:'a9-v17-local-only'},d1Persist:resolve(dataDir,'d1'),
      outboundService:{network:{deny:['0.0.0.0/0','::/0']}},
      bindings:{ A9_ENVIRONMENT:'candidate',A9_NETWORK:'testnet',A9_PROTOCOL_VERSION:'v17',
        A9_PUBLIC_ORIGIN:origin,A9_API_ORIGIN:origin,A9_ALLOWED_ORIGINS:origin,A9_TON_PROOF_DOMAINS:'127.0.0.1',
        A9_STAKE_SECONDS:'120',A9_OBS_SECONDS:'60',A9_VESTING_SECONDS:'600',A9_EARLY_WINDOW_SECONDS:'30',A9_ABORT_TIMEOUT_SECONDS:'120',
        A9_TG_BOT_HANDLE:'A9_TestnetBot',A9_BOT_TOKEN:'',A9_ADMIN_TOKEN:'',A9_TG_WEBHOOK_SECRET:'',
        A9_PRESALE_OPEN:'0',A9_CHEST_OPEN_ENABLED:'0',A9_BROADCAST_ENABLED:'0',A9_REQUIRE_RUNNER_HEARTBEAT:'1',
        A9_JETTON_MASTER_ADDRESS:'',A9_ROUND_CONTROLLER_ADDRESS:'',A9_PROMO_HOT_WALLET_ADDRESS:'',A9_PRESALE_HOT_WALLET_ADDRESS:'' },
    };
    mf = new Miniflare(mfRuntime.convertV4MiniflareOptions ? mfRuntime.convertV4MiniflareOptions(mfOptions) : mfOptions);
    const db = await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE IF NOT EXISTS a9_local_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)').run();
    // This candidate mirrors the wave 1A schema. Finality uses a separate local test database.
    const files = (await readdir(migrationRoot))
      .filter(name => /^\d{4}_.+\.sql$/.test(name) && name !== '0016_v17_finality_snapshots.sql')
      .sort();
    if (files.length !== 15 || files.some((n,i)=>!n.startsWith(String(i+1).padStart(4,'0')+'_'))) throw new Error('Expected locked migration sequence 0001..0015');
    for(const name of files){
      const sql=await readFile(resolve(migrationRoot,name),'utf8');const hash=createHash('sha256').update(sql).digest('hex');
      const applied=await db.prepare('SELECT sha256 FROM a9_local_migrations WHERE name=?').bind(name).first();
      if(applied){if(applied.sha256!==hash)throw new Error('Local migration fingerprint mismatch: '+name);continue;}
      const statements=sql.replace(/--[^\n]*/g,'').split(/;\s*(?:\n|$)/).map(s=>s.trim()).filter(Boolean);
      try { await db.batch([...statements.map(s=>db.prepare(s)),db.prepare('INSERT INTO a9_local_migrations(name,sha256) VALUES(?,?)').bind(name,hash)]); } catch { throw new Error('Local migration failed: '+name); }
    }
    const integrity = await db.prepare('SELECT COUNT(*) AS count FROM a9_local_migrations').first();
    if (integrity.count !== 15) throw new Error('Local D1 migration count failed');
    const status={environment:'local-v17-candidate',network:'testnet',runtime:'workerd/D1 local',migrations:files,dbIntegrity:'not-run: D1 does not authorize PRAGMA integrity_check',dbReadable:true,
      chainConnected:false,outboundNetwork:'denied',secretsConfigured:false,botConnected:false,walletsConfigured:false,
      liveFundsEnabled:false,A9_PRESALE_OPEN:'0',A9_CHEST_OPEN_ENABLED:'0',A9_BROADCAST_ENABLED:'0',
      workerBundleSha256:createHash('sha256').update(buildResult.outputFiles[0].text).digest('hex'),dataDir};
    server=createServer(async(req,res)=>{
      const send=(code,body,type='application/json; charset=utf-8')=>{res.writeHead(code,{'content-type':type,'cache-control':'no-store','x-a9-environment':'local-v17-candidate','x-content-type-options':'nosniff'});res.end(body);};
      try{
        const path=new URL(req.url,origin).pathname;
        if(!['GET','HEAD'].includes(req.method))return send(403,JSON.stringify({ok:false,error:{code:'LOCAL_CANDIDATE_READ_ONLY'}}));
        if(path==='/__candidate/status')return send(200,JSON.stringify(status));
        if(path.startsWith('/api/')||path.startsWith('/c/')){
          const response=await mf.dispatchFetch(origin+req.url,{method:req.method,headers:{origin}});
          return send(response.status,Buffer.from(await response.arrayBuffer()),response.headers.get('content-type')||'application/json');
        }
        if(path==='/js/runtime-config.js')return send(200,'window.__A9_CONFIG__ = '+JSON.stringify(localRuntimeConfig(port))+';','text/javascript; charset=utf-8');
        const file=resolve(appRoot,'.'+decodeURIComponent(path==='/'?'/index.html':path));
        if(!file.startsWith(appRoot+sep))return send(403,'Forbidden','text/plain');
        let content;
        try{content=await readFile(file);}catch{return send(404,'Not found','text/plain');}
        if(extname(file)==='.html')content=Buffer.from(content.toString().replace('<title>','<title>[本地隔离候选] ').replace(/<link rel="(?:preconnect|dns-prefetch)"[^>]+>/g,''));
        send(200,content,MIME[extname(file)]||'application/octet-stream');
      }catch{send(500,JSON.stringify({ok:false,error:{code:'LOCAL_CANDIDATE_REQUEST_FAILED'}}));}
    });
    await new Promise((ok,bad)=>{server.once('error',bad);server.listen(port,'127.0.0.1',ok);});
    return {origin,status,stop};
  }catch(e){await stop();throw e;}
}
if(process.argv[1] && resolve(process.argv[1])===mainFile){
  let instance;
  try{
    const args=process.argv.slice(2);if(args.some(a=>!['--smoke','--port'].includes(a)&&!/^\d+$/.test(a)))throw new Error('Only --smoke and --port are supported; no remote/execute mode exists');
    const i=args.indexOf('--port');
    instance=await startLocalCandidate({port:i>=0?Number(args[i+1]):8097,miniflareModule:process.env.MINIFLARE_MODULE,esbuildModule:process.env.ESBUILD_MODULE});
    console.log('Local candidate: '+instance.origin+'/?mode=live#/challenge');
    console.log('Readiness: '+instance.origin+'/__candidate/status');
    console.log('Local D1 migrations: 15/15; outbound denied; no secrets or signing keys loaded.');
    if(args.includes('--smoke')){
      const health=await fetch(instance.origin+'/api/health');const body=await health.json();
      if(health.status!==503||body.error?.code!=='CANDIDATE_CONFIG_INCOMPLETE')throw new Error('Expected fail-closed candidate without chain addresses');
      const writes=await fetch(instance.origin+'/api/presale/intent',{method:'POST'});if(writes.status!==403)throw new Error('Write gate failed');
      const asset=await fetch(instance.origin+'/js/demo-loader.js');if(!asset.ok||!asset.headers.get('content-type').includes('javascript'))throw new Error('JavaScript asset delivery failed');
      const missing=await fetch(instance.origin+'/js/nonexistent.js');if(missing.status!==404)throw new Error('Missing asset must not return HTML');
      console.log('LOCAL_CANDIDATE_SMOKE_PASS (not a blockchain test)');await instance.stop();
    }else{for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>instance.stop().then(()=>process.exit(0)));}
  }catch(e){console.error('Local candidate failed: '+e.message);process.exitCode=1;}
}
