// Read-only operator entry point for the isolated v17 candidate.
import { readFileSync } from 'node:fs';
import { TonCenterClient } from '../../worker/src/toncenter.mjs';
import { parseBoc } from '../../worker/src/ton-cell.mjs';
import { normalizeTonAddress } from '../../worker/src/ton-address.mjs';
import { buildVerifiedRoundFinalitySnapshot, createTonCenterV17ChainReader } from '../../worker/src/v17-finality-verifier.mjs';
import { EXTERNAL_W5_PACKAGE_VERSION, prepareExternalW5Package, createTonCenterW5ChainVerifier, verifyOnChainW5Evidence } from './lib/external-w5-signer.mjs';

const controller = 'kQCqh657Pt1LpQQWpherJOWcz6YG-wS_xpGFLMcRLxROgpm_';
const client = new TonCenterClient({ apiBase: 'https://testnet.toncenter.com/api/v2', testnet: true });

function readCandidateInput(file) {
  const input = JSON.parse(readFileSync(file, 'utf8'));
  if (input.network !== 'testnet' || input.chainId !== '-3' ||
      normalizeTonAddress(input.targetContract) !== normalizeTonAddress(controller)) {
    throw new Error('Expected a Testnet package for the candidate RoundController');
  }
  return input;
}

function validateCandidateAction(input) {
  const layouts = {
    'open-round': { opcode: 0x52540001n, bits: 352, role: 'roundOpener', signer: '0:83571c071862e52ec2416cfbf6ebcee20b47c879bc9ae67ed399e8283e11d9c7' },
    'settle-round': { opcode: 0x52540002n, bits: 392, role: 'keeper', signer: '0:8ff9f6b3f77109abd97177ccc6d7cab678a33603e43f4389cf73214619a694e2' },
  };
  const layout = Object.hasOwn(layouts, input.action) && layouts[input.action];
  const roots = parseBoc(input.payloadBoc);
  if (!layout || input.role !== layout.role || normalizeTonAddress(input.signerAddress) !== layout.signer || roots.length !== 1 ||
      roots[0].refs.length || roots[0].bits !== layout.bits || roots[0].readBits(0, 32) !== layout.opcode) {
    throw new Error('Candidate role, action or payload layout mismatch');
  }
}

async function prepareCandidateW5(file) {
  const input = readCandidateInput(file);
  validateCandidateAction(input);
  const stack = await client.runGetMethod(input.signerAddress, 'seqno');
  const value = TonCenterClient.parseStrictNum(stack[0], { allowNegative: false });
  if (value === null || value > 0xffffffffn) throw new Error('Invalid chain seqno');
  const nowSec = Math.floor(Date.now() / 1000);
  return prepareExternalW5Package({ ...input, nowSec, seqno: Number(value), validUntil: nowSec + 300 });
}

async function checkW5(file) {
  const input = readCandidateInput(file);
  validateCandidateAction(input);
  if (input.version !== EXTERNAL_W5_PACKAGE_VERSION) throw new Error('Unsupported package version');
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) throw new Error('Invalid package timestamp');
  const pkg = await prepareExternalW5Package({ ...input, nowSec: input.createdAt });
  if (pkg.packageHash !== input.packageHash || pkg.packageId !== input.packageId) throw new Error('Package integrity mismatch');
  const verifier = createTonCenterW5ChainVerifier({
    network: 'testnet',
    fetchJson: (path, options) => client._requestV3(path, options),
  });
  const evidence = await verifier(pkg);
  const result = await verifyOnChainW5Evidence(pkg, evidence);
  if (!result.ok) throw new Error(evidence.reason || result.reason);
  return { packageId: pkg.packageId, walletTxHash: evidence.walletTx.hash, targetTxHash: evidence.targetTx.hash };
}

try {
  const [action, value, ...extra] = process.argv.slice(2);
  if (!value || extra.length) throw new Error('Usage: candidate-chain-check.mjs round ROUND_ID | prepare-w5 INPUT.json | w5 PACKAGE.json');
  let result;
  if (action === 'round' && /^[1-9]\d*$/.test(value) && Number(value) <= 0xffffffff) {
    result = await buildVerifiedRoundFinalitySnapshot({ network: 'testnet', roundController: controller,
      roundId: Number(value), chainReader: createTonCenterV17ChainReader({ tonCenter: client }) });
  } else if (action === 'prepare-w5') {
    result = await prepareCandidateW5(value);
  } else if (action === 'w5') {
    result = await checkW5(value);
  } else {
    throw new Error('Expected round with a positive uint32 ID, or w5 with a package file');
  }
  console.log(JSON.stringify(result));
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
