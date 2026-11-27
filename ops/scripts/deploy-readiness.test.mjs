import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { probeRpc, ZERO_STATES, checkDeploymentReadiness, verifyLockedBundle } from './lib/deploy-readiness.mjs';
import { validateDeployPreflight } from './lib/v15-core.mjs';
const bundle = JSON.parse(readFileSync(new URL('../deploy-console/bundle-mainnet-v17.0.json',import.meta.url)));
const env = {TONCENTER_API_KEY:'fixture-key',A9_METADATA_URI:bundle.metadataUri,A9_KEEPER_ADDRESS:bundle.roles.keeper,A9_TEAM_WALLET_ADDRESS:bundle.roles.teamWallet,A9_ROUND_OPENER_ADDRESS:bundle.roles.roundOpener,A9_DEPLOY_WALLET:'dep',A9_TREASURY_WALLET:'tre'};
const reply=(body,status=200)=>({ok:status===200,status,json:async()=>body,headers:{get:()=> 'image/png'}});
const rpcBody=(network='mainnet')=>({ok:true,result:{init:{workchain:-1,root_hash:ZERO_STATES[network]},last:{workchain:-1,seqno:123}}});
const spawnOK=()=>({status:0,stdout:`Deployer = ${bundle.roles.deployer}\nTreasury = ${bundle.roles.treasury}\nJettonMaster = ${bundle.contracts.jettonMaster}\nRoundController = ${bundle.contracts.roundController}\nDRY-RUN: no on-chain messages sent.\n`});
const fetchOK=async u=>String(u).includes('getMasterchainInfo')?reply(rpcBody()):String(u).endsWith('a9.json')?reply({name:'A9',symbol:'A9',decimals:'9',image:'https://fixture.invalid/token.png'}):reply({});
test('RPC rejects auth failure, error envelope, wrong network, timeout and malformed chain state without exposing key',async()=>{
 for(const [fn,code] of [[async()=>reply({},401),'RPC_HTTP_401'],[async()=>reply({},403),'RPC_HTTP_403'],[async()=>reply({ok:false}),'RPC_RESPONSE_INVALID'],[async()=>reply(rpcBody('testnet')),'RPC_NETWORK_MISMATCH'],[async()=>{throw new Error('fixture-key');},'RPC_UNAVAILABLE']])await assert.rejects(probeRpc({network:'mainnet',env,fetchImpl:fn}),new RegExp(code));
 await assert.rejects(probeRpc({network:'mainnet',env,timeoutMs:5,fetchImpl:async(_,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('aborted'))))}),/RPC_TIMEOUT/);
 assert.equal((await probeRpc({network:'mainnet',env,fetchImpl:async()=>reply(rpcBody())})).ok,true);
});
test('locked bundle StateInit and compiled code identity are checked, changed bytes rejected',async()=>{
 const p=validateDeployPreflight({profile:'mainnet',resolveWallets:false,requireDeployWalletNames:false});
 assert.ok((await verifyLockedBundle(p)).derived.jettonMaster);
 await assert.rejects(verifyLockedBundle({...p,readFile:()=>Buffer.from('{}')}),/BUNDLE_FINGERPRINT_MISMATCH/);
});
test('mainnet cannot pass with unavailable RPC, wrong derived wallet, partial output or undeclared signers',async()=>{
 const a=await checkDeploymentReadiness({profile:'mainnet',env,spawnImpl:spawnOK,fetchImpl:fetchOK});
 assert.equal(a.readyForExecute,false);assert.ok(a.errors.includes('SIGNER_MANIFEST_REQUIRED'));
 const b=await checkDeploymentReadiness({profile:'mainnet',env,spawnImpl:()=>({...spawnOK(),stdout:spawnOK().stdout.replace(bundle.roles.deployer,bundle.roles.keeper)}),fetchImpl:fetchOK});
 assert.equal(b.checks.bundle,false);assert.ok(b.errors.some(e=>e.includes('DERIVED_WALLET_MISMATCH')));
 const c=await checkDeploymentReadiness({profile:'mainnet',env,spawnImpl:()=>({status:0,stdout:'DRY-RUN: no on-chain messages sent.\n'}),fetchImpl:fetchOK});
 assert.equal(c.readyForExecute,false);assert.ok(c.errors.some(e=>e.includes('INCOMPLETE')));
 const d=await checkDeploymentReadiness({profile:'mainnet',env,spawnImpl:spawnOK,fetchImpl:async()=>reply({},403)});
 assert.equal(d.readyForExecute,false);assert.ok(d.errors.includes('RPC_HTTP_403'));
});
test('CLI emits explicit false and nonzero on missing configuration without broadcasting',()=>{
 const r=spawnSync(process.execPath,[new URL('./deploy-v15.mjs',import.meta.url).pathname,'--profile','mainnet','--strict','--dry-run'],{encoding:'utf8',env:{PATH:process.env.PATH}});
 assert.notEqual(r.status,0);assert.match(r.stdout,/"readyForExecute": false/);assert.match(r.stdout,/RPC_KEY_MISSING/);
});
test('all local signer roles must resolve and match; complete evidence alone permits local readiness',async()=>{
 const roles=Object.fromEntries(Object.entries(bundle.roles).map(([r,address])=>[r,{mode:'local',address,walletName:r==='deployer'?'dep':r==='treasury'?'tre':r}]));
 const signerManifest={network:'mainnet',roles};
 const spawn=(cmd,args)=>args.some(a=>a.includes('inspect_signers'))?{status:0,stdout:Object.entries(bundle.roles).map(([r,a])=>`SIGNER_${r} = ${a}`).join('\n')+'\nA9_SIGNERS_READ_ONLY_OK\n'}:spawnOK();
 const a=await checkDeploymentReadiness({profile:'mainnet',env,signerManifest,spawnImpl:spawn,fetchImpl:fetchOK});
 assert.deepEqual(a.errors,[]);assert.equal(a.readyForExecute,true);
 const bad=structuredClone(signerManifest);bad.roles.promoHotWallet.address=bundle.roles.presaleHotWallet;
 const b=await checkDeploymentReadiness({profile:'mainnet',env,signerManifest:bad,spawnImpl:spawn,fetchImpl:fetchOK});
 assert.equal(b.readyForExecute,false);assert.ok(b.errors.some(e=>e.includes('SIGNER_SOURCE')));
 const missing=structuredClone(signerManifest);delete missing.roles.keeper;
 const c=await checkDeploymentReadiness({profile:'mainnet',env,signerManifest:missing,spawnImpl:spawn,fetchImpl:fetchOK});assert.equal(c.readyForExecute,false);
});
test('external declaration requires matching public StateInit, checks v5r1 network/signature bits, and never substitutes for local CLI signing',async()=>{
 const {verifySignerSources}=await import('./lib/deploy-readiness.mjs');
 const {makeV5R1Wallet}=await import('../../worker/tests/helpers/test-env.mjs');
 const f=JSON.parse(readFileSync(new URL('../../worker/tests/fixtures/ton-proof-fixtures.json',import.meta.url))).vectors[0];
 const roles=Object.fromEntries(Object.keys(bundle.roles).map(r=>[r,f.address]));
 const manifest={network:'mainnet',roles:Object.fromEntries(Object.keys(roles).map(r=>[r,{mode:'hardware',address:f.address,source:'fixture only',version:'v4r2',stateInit:f.proof.state_init}]))};
 assert.equal((await verifySignerSources({manifest,bundle:{roles},env:{},protocolRoot:''})).treasury.mode,'hardware');
 manifest.roles.keeper.stateInit='AA==';await assert.rejects(verifySignerSources({manifest,bundle:{roles},env:{},protocolRoot:''}));

 // Real v5r1 mainnet StateInit passes; testnet v5r1 StateInit disguised on mainnet or signature-disabled v5r1 fails closed
 const w5Main=await makeV5R1Wallet({network:'-239',subwallet:0,isSignatureAllowed:true});
 const w5MainRoles=Object.fromEntries(Object.keys(bundle.roles).map(r=>[r,w5Main.address]));
 const w5MainManifest={network:'mainnet',roles:Object.fromEntries(Object.keys(w5MainRoles).map(r=>[r,{mode:'tonconnect',address:w5Main.address,source:'tonkeeper-w5',version:'v5r1',stateInit:w5Main.stateInit}]))};
 assert.equal((await verifySignerSources({manifest:w5MainManifest,bundle:{roles:w5MainRoles},env:{},protocolRoot:''})).deployer.mode,'tonconnect');

 const w5Test=await makeV5R1Wallet({network:'-3',subwallet:0,isSignatureAllowed:true});
 const w5WrongNetRoles={...w5MainRoles,teamWallet:w5Test.address};
 const w5WrongNetManifest=structuredClone(w5MainManifest);
 w5WrongNetManifest.roles.teamWallet={mode:'tonconnect',address:w5Test.address,source:'tonkeeper-w5-testnet',version:'v5r1',stateInit:w5Test.stateInit};
 await assert.rejects(verifySignerSources({manifest:w5WrongNetManifest,bundle:{roles:w5WrongNetRoles},env:{},protocolRoot:''}),/SIGNER_EXTERNAL_WALLET_NETWORK_MISMATCH_teamWallet/);

 const w5NoSig=await makeV5R1Wallet({network:'-239',subwallet:0,isSignatureAllowed:false});
 const w5NoSigRoles={...w5MainRoles,treasury:w5NoSig.address};
 const w5NoSigManifest=structuredClone(w5MainManifest);
 w5NoSigManifest.roles.treasury={mode:'hardware',address:w5NoSig.address,source:'ledger-w5',version:'v5r1',stateInit:w5NoSig.stateInit};
 await assert.rejects(verifySignerSources({manifest:w5NoSigManifest,bundle:{roles:w5NoSigRoles},env:{},protocolRoot:''}),/SIGNER_EXTERNAL_SIGNATURE_DISABLED_treasury/);

 const r=await checkDeploymentReadiness({profile:'mainnet',env,deploymentMode:'external',execute:true,signerManifest:null,fetchImpl:fetchOK});
 assert.equal(r.readyForExecute,false);assert.ok(r.errors.includes('EXTERNAL_DEPLOYMENT_REQUIRES_CONSOLE'));
});
