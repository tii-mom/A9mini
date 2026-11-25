#!/usr/bin/env node
/**
 * A9 v16.2 主网「零私钥 · 手机钱包扫码」5 步部署交易包生成器
 *
 * - 严格先校验 v16/ci/artifacts.sha256（4 份锁定合约产物）
 * - 使用 TON 官方 @ton/core 构造与 Tolk v16.2 结构体逐位一致的 StateInit & Payload BOC
 * - 生成后必须配合 ops/tolk/verify_mainnet_bundle_v16.tolk 在本地 TVM 沙盒完成 100% 端到端交叉验真
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { verifyV15Artifacts, loadParams, OPS_ROOT, V17_ROOT } from './lib/v15-core.mjs';

const require = createRequire(import.meta.url);
const { Address, Cell, Dictionary, beginCell, storeStateInit } = require('/tmp/a9-ton-tools/node_modules/@ton/core');

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(OPS_ROOT, 'deploy-console');
const OUT_FILE = resolve(OUT_DIR, 'bundle-mainnet-v17.0.json');

// 业主确认的 6 个主网正式 W5 地址（零私钥，仅公开地址）
const MAINNET_ROLES = Object.freeze({
  deployer: 'UQBqTR8EYSz-uNKIBODC-3z0vOFlqoBGzLJb38wJOvCuiwbX',
  treasury: 'UQCOoxmYvHU7OmvLOWGGSAS7RKalF-2lI_M1S6I1Dx0stW7e',
  keeper: 'UQA1vS1TvBUBEr0jTEBDbexKsDIL_74tOfleC08UmU32dLOI',
  roundOpener: 'UQA1vS1TvBUBEr0jTEBDbexKsDIL_74tOfleC08UmU32dLOI',
  teamWallet: 'UQCJGnTxROjaSiuY-gXDzeoIhZy8W1_x_74H3SxbggZM0Qyf',
  presaleHotWallet: 'UQA0lNLvLrVVnmpwj6gkxOmKQX-TzGS5QrJZOYjOi4DWrCHG',
  promoHotWallet: 'UQC4L819s6ENEWU51X1kAZ2lrFESvW670z_ziRa1sZyzQilQ',
});

const METADATA_URI = 'https://app.a9.lat/a9.json';

// 精算 3 GRAM 预算内的 5 步 Gas（远高于合约最低保底：JM 18x、RC 6.5x；余量原路退回签名钱包）
const STEP_AMOUNTS = Object.freeze({
  deployMasterNano: '200000000',     // 0.20 GRAM (deployer)
  mintTotalNano: '350000000',        // 0.35 GRAM (treasury, excess refunded)
  mintForwardNano: '150000000',      // 0.15 GRAM forward inside MintOnce
  mintMsgTotalNano: '200000000',     // 0.20 GRAM totalTonAmount inside MintOnce
  dropAdminNano: '60000000',         // 0.06 GRAM (treasury, excess refunded)
  deployRcNano: '700000000',         // 0.70 GRAM (deployer, 7x RC_MIN_BALANCE)
  fundRcNano: '200000000',           // 0.20 GRAM (treasury, excess refunded)
});

function loadCodeCell(name) {
  const json = JSON.parse(readFileSync(resolve(V17_ROOT, 'build', `${name}.json`), 'utf8'));
  return Cell.fromBase64(json.code_boc64);
}

function sha256BigInt(str) {
  return BigInt('0x' + createHash('sha256').update(str, 'utf8').digest('hex'));
}

/** TEP-64 Snake string with 0x00 prefix (exact Tolk string.prefixWith00() layout: 0x00 + ref(utf8)) */
function buildPrefixed00Cell(utf8Str) {
  const strCell = beginCell().storeBuffer(Buffer.from(utf8Str, 'utf8')).endCell();
  return beginCell().storeUint(0x00, 8).storeRef(strCell).endCell();
}

/** Tolk JettonWallet SHARD_DEPTH=8 deterministic address derivation */
function calcShardedJettonWalletAddress(ownerAddr, minterAddr, walletCodeCell) {
  const data = beginCell()
    .storeCoins(0n)
    .storeAddress(ownerAddr)
    .storeAddress(minterAddr)
    .endCell();
  // Tolk AutoDeployAddress with toShard { fixedPrefixLength: 8, closeTo: ownerAddr }
  // sets fixed_prefix_length = 8 in StateInit (split_depth = 8) and replaces top 8 bits of hash with ownerAddr.hash[0].
  const initCell = beginCell()
    .store(storeStateInit({ splitDepth: 8, code: walletCodeCell, data }))
    .endCell();
  const hash = Buffer.from(initCell.hash());
  hash[0] = ownerAddr.hash[0];
  return new Address(0, hash);
}

function main() {
  // 1. 强校验 v17 锁定哈希
  const verified = verifyV15Artifacts(V17_ROOT);
  const { data: params } = loadParams('mainnet');

  const deployerAddr = Address.parse(MAINNET_ROLES.deployer);
  const treasuryAddr = Address.parse(MAINNET_ROLES.treasury);
  const keeperAddr = Address.parse(MAINNET_ROLES.keeper);
  const openerAddr = Address.parse(MAINNET_ROLES.roundOpener);
  const teamAddr = Address.parse(MAINNET_ROLES.teamWallet);
  for (const [k, a] of [['deployer', deployerAddr], ['treasury', treasuryAddr], ['keeper', keeperAddr], ['teamWallet', teamAddr]]) {
    if (a.workChain !== 0) throw new Error(`${k} must be Basechain (workchain 0)`);
  }

  const masterCode = loadCodeCell('JettonMaster');
  const walletCode = loadCodeCell('JettonWallet');
  const controllerCode = loadCodeCell('RoundController');
  const ticketCode = loadCodeCell('StakeTicket');

  // 2. JettonMaster StateInit (与 deploy_v16.tolk 第 111-122 行逐位一致)
  const contentDict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  contentDict.set(sha256BigInt('uri'), buildPrefixed00Cell(METADATA_URI));
  const metadataCell = beginCell()
    .storeUint(0x00, 8)
    .storeDict(contentDict)
    .endCell();

  const masterData = beginCell()
    .storeCoins(0n)                // totalSupply = 0
    .storeAddress(treasuryAddr)    // adminAddress = treasury
    .storeAddress(null)            // nextAdminAddress = null (addr_none)
    .storeRef(metadataCell)        // metadata: cell
    .endCell();

  const masterStateInitCell = beginCell()
    .store(storeStateInit({ code: masterCode, data: masterData }))
    .endCell();
  const masterAddr = new Address(0, masterStateInitCell.hash());

  // 3. RoundController StateInit (与 deploy_v16.tolk 第 124-163 行逐位一致)
  const econCell = beginCell()
    .storeAddress(teamAddr)
    .storeUint(BigInt(params.econ.p0UsdE8), 128)
    .storeUint(BigInt(params.econ.roundRewardRaw), 128)
    .storeUint(BigInt(params.econ.teamRoundRaw), 128)
    .storeUint(BigInt(params.econ.minStakeRaw), 128)
    .endCell();

  const timingCell = beginCell()
    .storeUint(BigInt(params.timing.stakeDurationSeconds), 32)
    .storeUint(BigInt(params.timing.earlyWindowSeconds), 32)
    .storeUint(BigInt(params.timing.observationSeconds), 32)
    .storeUint(BigInt(params.timing.candleCount), 8)
    .storeUint(BigInt(params.timing.minQualifiedCandles), 8)
    .storeUint(BigInt(params.timing.abortTimeoutSeconds), 32)
    .storeUint(BigInt(params.timing.vestingSeconds), 32)
    .endCell();

  const codesCell = beginCell()
    .storeRef(walletCode)
    .storeRef(ticketCode)
    .endCell();

  const configCell = beginCell()
    .storeAddress(keeperAddr)
    .storeAddress(openerAddr)
    .storeAddress(masterAddr)
    .storeRef(econCell)
    .storeRef(timingCell)
    .storeRef(codesCell)
    .endCell();

  const controllerData = beginCell()
    .storeRef(configCell)
    .storeBit(0) // rounds: empty map<uint32, RoundData>
    .storeUint(0n, 32) // currentRoundId
    .storeUint(0n, 32) // successCount
    .storeUint(BigInt(params.supply.rewardPoolRaw), 128)
    .storeUint(0n, 128) // carryRaw
    .storeUint(BigInt(params.supply.teamPoolRaw), 128)
    .storeUint(0n, 128) // teamCarryRaw
    .storeUint(0n, 64) // lastSuccessAt
    .storeUint(0n, 64) // endAt
    .storeUint(0n, 128) // pendingTeamReleaseRaw
    .storeUint(0n, 128) // pendingBurnRaw
    .endCell();

  const controllerStateInitCell = beginCell()
    .store(storeStateInit({ code: controllerCode, data: controllerData }))
    .endCell();
  const controllerAddr = new Address(0, controllerStateInitCell.hash());

  // 4. 派生两个 sharded JettonWallet 地址（与 JettonMaster.get_wallet_address 逐位一致）
  const treasuryJettonWalletAddr = calcShardedJettonWalletAddress(treasuryAddr, masterAddr, walletCode);
  const rcJettonWalletAddr = calcShardedJettonWalletAddress(controllerAddr, masterAddr, walletCode);

  // 5. 构造 5 笔交易载荷 BOC
  const topUpTonsBody = beginCell().storeUint(0xd372158c, 32).endCell();

  const mintOnceBody = beginCell()
    .storeUint(0x00000015, 32)                         // MintOnce
    .storeUint(1n, 64)                                 // queryId
    .storeAddress(treasuryAddr)                        // recipient
    .storeCoins(BigInt(STEP_AMOUNTS.mintForwardNano))  // tonAmount (0.15 GRAM)
    .storeCoins(BigInt(params.supply.totalSupplyRaw))  // jettonAmount (10B A9)
    .storeCoins(BigInt(STEP_AMOUNTS.mintMsgTotalNano)) // totalTonAmount (0.20 GRAM)
    .storeUint(0, 1)                                   // inline empty forwardPayload
    .endCell();

  const dropAdminBody = beginCell()
    .storeUint(0x7431f221, 32) // DropMinterAdmin
    .storeUint(2n, 64)         // queryId
    .endCell();

  const fundRcBody = beginCell()
    .storeUint(0x0f8a7ea5, 32)                         // OP_JETTON_TRANSFER (AskToTransfer)
    .storeUint(3n, 64)                                 // queryId
    .storeCoins(BigInt(params.supply.rcFundingRaw))    // 8,200,000,000 A9
    .storeAddress(controllerAddr)                      // transferRecipient = RoundController
    .storeAddress(treasuryAddr)                        // sendExcessesTo = treasury
    .storeMaybeRef(null)                               // customPayload = null
    .storeCoins(0n)                                    // forwardTonAmount = 0
    .storeUint(0, 1)                                   // inline empty forwardPayload
    .endCell();

  const bundle = {
    protocolVersion: '17.0.0',
    network: 'mainnet',
    chainId: '-239',
    metadataUri: METADATA_URI,
    artifactsSha256: verified,
    roles: MAINNET_ROLES,
    timing: params.timing,
    supply: params.supply,
    contracts: {
      jettonMaster: masterAddr.toString({ bounceable: true, testOnly: false }),
      jettonMasterRaw: masterAddr.toRawString(),
      roundController: controllerAddr.toString({ bounceable: true, testOnly: false }),
      roundControllerRaw: controllerAddr.toRawString(),
      treasuryJettonWallet: treasuryJettonWalletAddr.toString({ bounceable: true, testOnly: false }),
      treasuryJettonWalletRaw: treasuryJettonWalletAddr.toRawString(),
      rcJettonWallet: rcJettonWalletAddr.toString({ bounceable: true, testOnly: false }),
      rcJettonWalletRaw: rcJettonWalletAddr.toRawString(),
    },
    budgetPlan: {
      deployerRecommendedGram: '1.10',
      treasuryRecommendedGram: '0.70',
      totalRecommendedGram: '1.80',
      estimatedNetSpendGram: '~1.15',
    },
    steps: [
      {
        step: 1,
        id: 'deploy-jetton-master',
        title: '第 1 步 · 部署 A9 代币主合约 (JettonMaster)',
        signerRole: 'deployer',
        signerAddress: MAINNET_ROLES.deployer,
        amountGram: '0.20',
        message: {
          address: masterAddr.toString({ bounceable: false, testOnly: false }),
          amount: STEP_AMOUNTS.deployMasterNano,
          stateInit: masterStateInitCell.toBoc().toString('base64'),
          payload: topUpTonsBody.toBoc().toString('base64'),
        },
        description: '使用部署钱包 (UQBq...wbX) 部署标准 TEP-74 JettonMaster，初始管理员指向金库钱包，元数据永久指向 https://app.a9.lat/a9.json。',
      },
      {
        step: 2,
        id: 'mint-10b-once',
        title: '第 2 步 · 一次性铸造 10,000,000,000 A9 至金库',
        signerRole: 'treasury',
        signerAddress: MAINNET_ROLES.treasury,
        amountGram: '0.35',
        message: {
          address: masterAddr.toString({ bounceable: true, testOnly: false }),
          amount: STEP_AMOUNTS.mintTotalNano,
          payload: mintOnceBody.toBoc().toString('base64'),
        },
        description: '使用金库钱包 (UQCO...W7e) 调用 MintOnce 一次性铸造 100 亿 A9 至金库钱包（Gas 余量自动退回）。',
      },
      {
        step: 3,
        id: 'drop-minter-admin',
        title: '第 3 步 · 验明实收 100 亿后永久弃权 (DropMinterAdmin)',
        signerRole: 'treasury',
        signerAddress: MAINNET_ROLES.treasury,
        amountGram: '0.06',
        message: {
          address: masterAddr.toString({ bounceable: true, testOnly: false }),
          amount: STEP_AMOUNTS.dropAdminNano,
          payload: dropAdminBody.toBoc().toString('base64'),
        },
        description: '控制台先自动核验金库 JettonWallet 实收 10,000,000,000 A9，再由金库钱包永久销毁铸币管理员权限（admin_address = addr_none，永不可增发）。',
      },
      {
        step: 4,
        id: 'deploy-round-controller',
        title: '第 4 步 · 部署主控合约 (RoundController v17.0)',
        signerRole: 'deployer',
        signerAddress: MAINNET_ROLES.deployer,
        amountGram: '0.70',
        message: {
          address: controllerAddr.toString({ bounceable: false, testOnly: false }),
          amount: STEP_AMOUNTS.deployRcNano,
          stateInit: controllerStateInitCell.toBoc().toString('base64'),
          payload: topUpTonsBody.toBoc().toString('base64'),
        },
        description: '使用部署钱包 (UQBq...wbX) 部署 v17.0 涨价解锁 RoundController（24H 锁仓/头矿 6H 5% 止损/12H 冲价/14 天逐秒解锁/3 折急提）。',
      },
      {
        step: 5,
        id: 'fund-rc-82b',
        title: '第 5 步 · 向主控合约注资 8,200,000,000 A9 奖池与团队池',
        signerRole: 'treasury',
        signerAddress: MAINNET_ROLES.treasury,
        amountGram: '0.20',
        message: {
          address: treasuryJettonWalletAddr.toString({ bounceable: true, testOnly: false }),
          amount: STEP_AMOUNTS.fundRcNano,
          payload: fundRcBody.toBoc().toString('base64'),
        },
        description: '使用金库钱包 (UQCO...W7e) 将 82 亿 A9（70 亿奖池 + 12 亿团队池）划入 RoundController；剩余 18 亿 A9 留在你手机金库冷存。',
      },
    ],
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  console.log('Generated verified bundle draft:', OUT_FILE);
  console.log('  JettonMaster         =', bundle.contracts.jettonMaster);
  console.log('  RoundController      =', bundle.contracts.roundController);
  console.log('  TreasuryJettonWallet =', bundle.contracts.treasuryJettonWallet);
  console.log('  RcJettonWallet       =', bundle.contracts.rcJettonWallet);
}

main();
