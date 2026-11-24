/**
 * A9 Protocol v15 — Zero-dependency TON Connect 2.0 transaction builders.
 *
 * Covers ALL 3 user-initiated on-chain actions in v15:
 *   1) Stake A9: standard TEP-74 AskToTransfer (0x0f8a7ea5) -> user's A9 JettonWallet
 *      with forwardPayload ^Cell(0x5254000F + roundId + addr_none)
 *   2) Claim: TicketClaim (0x52540303) -> user's StakeTicket (>= 0.22 TON)
 *   3) Promo reward claim: 0.06 TON + "claim:<id>" text comment -> promoHotWallet (0 contract)
 */

export const V15_OPCODES = Object.freeze({
  JETTON_TRANSFER: 0x0f8a7ea5,
  STAKE_DEPOSIT: 0x5254000f,
  STAKE_DEPOSIT_V16: 0x52540010,
  TICKET_CLAIM: 0x52540303,
});

export const V15_GAS = Object.freeze({
  STAKE_FORWARD_NANO: '150000000',       // 0.15 TON forward to RoundController
  STAKE_TOTAL_NANO: '300000000',         // 0.30 TON attached to user's JettonWallet
  CLAIM_NANO: '220000000',               // 0.22 TON attached to StakeTicket
  PROMO_FEE_NANO: '60000000',            // 0.06 TON user-covered gas to promo hot wallet
});

function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function crc16Ccitt(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Parse friendly (EQ/UQ/kQ/0Q...) or raw (0:64hex) TON address into { workchain, hash }. */
export function parseTonAddress(addr) {
  const s = String(addr || '').trim();
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length !== 2) throw new Error(`invalid raw TON address: ${s}`);
    const [wcStr, hex] = parts;
    if (!/^-?\d+$/.test(wcStr) || !/^[0-9a-fA-F]{64}$/.test(hex || '')) throw new Error(`invalid raw TON address: ${s}`);
    const wc = Number(wcStr);
    if (wc !== 0 && wc !== -1) throw new Error(`invalid TON workchain: ${wcStr}`);
    const hash = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) hash[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return { workchain: wc, hash };
  }
  const bytes = base64UrlToBytes(s);
  if (bytes.length !== 36) throw new Error(`invalid friendly TON address length: ${bytes.length}`);
  const expectedCrc = (bytes[34] << 8) | bytes[35];
  if (crc16Ccitt(bytes.subarray(0, 34)) !== expectedCrc) {
    throw new Error('invalid friendly TON address CRC16 checksum');
  }
  const workchain = bytes[1] === 0xff ? -1 : bytes[1];
  if (workchain !== 0 && workchain !== -1) throw new Error(`invalid TON workchain: ${workchain}`);
  return { workchain, hash: bytes.subarray(2, 34) };
}

/** Minimalist TON bit-level cell builder (supports <= 1023 bits and child refs). */
class BitBuilder {
  constructor() {
    this.bits = [];
    this.refs = [];
  }

  storeBit(b) {
    this.bits.push(b ? 1 : 0);
    return this;
  }

  storeUint(value, bitLen) {
    const v = BigInt(value);
    for (let i = bitLen - 1; i >= 0; i -= 1) {
      this.bits.push(Number((v >> BigInt(i)) & 1n));
    }
    return this;
  }

  storeBytes(bytes) {
    for (let i = 0; i < bytes.length; i += 1) this.storeUint(bytes[i], 8);
    return this;
  }

  storeCoins(amount) {
    const v = BigInt(amount);
    if (v < 0n) throw new Error('coins cannot be negative');
    if (v === 0n) return this.storeUint(0, 4);
    const hex = v.toString(16);
    const byteLen = Math.ceil(hex.length / 2);
    this.storeUint(byteLen, 4);
    this.storeUint(v, byteLen * 8);
    return this;
  }

  storeAddress(addr) {
    const { workchain, hash } = parseTonAddress(addr);
    this.storeUint(0b10, 2); // addr_std
    this.storeBit(0);        // no anycast
    this.storeUint(workchain < 0 ? 0xff : workchain, 8);
    this.storeBytes(hash);
    return this;
  }

  storeRef(cell) {
    this.refs.push(cell);
    return this;
  }

  serializeCell(refIndices = []) {
    const bitLen = this.bits.length;
    if (bitLen > 1023) throw new Error('cell overflow (>1023 bits)');
    const fullBytes = Math.floor(bitLen / 8);
    const rem = bitLen % 8;
    const totalBytes = rem === 0 ? fullBytes : fullBytes + 1;
    const data = new Uint8Array(totalBytes);
    for (let i = 0; i < bitLen; i += 1) {
      if (this.bits[i]) data[i >> 3] |= 1 << (7 - (i & 7));
    }
    if (rem !== 0) {
      data[fullBytes] |= 1 << (7 - rem); // TON completion tag bit
    }
    const d1 = refIndices.length; // ordinary cell, level 0
    const d2 = fullBytes + totalBytes;
    const out = new Uint8Array(2 + totalBytes + refIndices.length);
    out[0] = d1;
    out[1] = d2;
    out.set(data, 2);
    for (let i = 0; i < refIndices.length; i += 1) out[2 + totalBytes + i] = refIndices[i];
    return out;
  }
}

/** Serialize 1 or 2 cells (root + optional 1 child ref) into standard TON BOC base64. */
function encodeCellsBoc(rootBuilder) {
  const hasChild = rootBuilder.refs.length === 1;
  const cells = hasChild
    ? [rootBuilder.serializeCell([1]), rootBuilder.refs[0].serializeCell([])]
    : [rootBuilder.serializeCell([])];
  const totSize = cells.reduce((s, c) => s + c.length, 0);
  if (totSize > 255) throw new Error('BOC exceeds single-byte size header');
  const out = new Uint8Array(11 + totSize);
  out[0] = 0xb5; out[1] = 0xee; out[2] = 0x9c; out[3] = 0x72; // BOC magic
  out[4] = 0x01; // flags: size_bytes=1, no crc/idx
  out[5] = 0x01; // off_bytes=1
  out[6] = cells.length;
  out[7] = 0x01; // roots=1
  out[8] = 0x00; // absent=0
  out[9] = totSize;
  out[10] = 0x00; // root_idx=0
  let offset = 11;
  for (const c of cells) {
    out.set(c, offset);
    offset += c.length;
  }
  return bytesToBase64(out);
}

/** Backward-compatible single-cell byte-aligned BOC encoder. */
export function encodeSingleCellBoc(dataBytes) {
  if (!(dataBytes instanceof Uint8Array)) throw new Error('dataBytes must be Uint8Array');
  if (dataBytes.length > 127) throw new Error('single-cell payload exceeds 127 bytes');
  return encodeCellsBoc(new BitBuilder().storeBytes(dataBytes));
}

/** Build standard TON text comment BOC: op(0x00000000) + UTF-8 bytes */
export function encodeTextCommentBoc(text) {
  const textBytes = new TextEncoder().encode(String(text));
  const payload = new Uint8Array(4 + textBytes.length);
  payload.set(textBytes, 4);
  return encodeSingleCellBoc(payload);
}

/** Build v15 StakeTicket TicketClaim BOC: op(0x52540303, 32b) + queryId(64b) */
export function encodeTicketClaimBoc(queryId = BigInt(Date.now())) {
  const b = new BitBuilder()
    .storeUint(V15_OPCODES.TICKET_CLAIM, 32)
    .storeUint(BigInt(queryId), 64);
  return encodeCellsBoc(b);
}

/**
 * Build standard TEP-74 AskToTransfer BOC for staking A9 into v15 RoundController.
 * Sends to user's A9 JettonWallet; forwards ^Cell(0x5254000F + roundId + addr_none) with 0.15 TON.
 */
export function encodeStakeJettonTransferBoc({
  roundController,
  responseDestination,
  amountA9Raw,
  roundId,
  queryId = BigInt(Date.now()),
  forwardTonNano = V15_GAS.STAKE_FORWARD_NANO,
  protocolVersion = 'v16',
}) {
  if (!roundController || !responseDestination) throw new Error('roundController and responseDestination required');
  if (BigInt(amountA9Raw) <= 0n) throw new Error('amountA9Raw must be positive');
  if (protocolVersion !== 'v15' && protocolVersion !== 'v16') throw new Error('unsupported stake protocol version');
  const wideRoundId = protocolVersion === 'v16';
  const maxRoundId = wideRoundId ? 0xffffffff : 255;
  const rId = Number(roundId);
  if (!Number.isInteger(rId) || rId < 1 || rId > maxRoundId) throw new Error(`roundId must be 1..${maxRoundId}`);

  const forwardCell = new BitBuilder()
    .storeUint(wideRoundId ? 0x52540010 : V15_OPCODES.STAKE_DEPOSIT, 32)
    .storeUint(rId, wideRoundId ? 32 : 8)
    .storeUint(0, 2); // beneficiary = addr_none (uses transferInitiator)

  const root = new BitBuilder()
    .storeUint(V15_OPCODES.JETTON_TRANSFER, 32)
    .storeUint(BigInt(queryId), 64)
    .storeCoins(BigInt(amountA9Raw))
    .storeAddress(roundController)
    .storeAddress(responseDestination)
    .storeBit(0) // custom_payload = null
    .storeCoins(BigInt(forwardTonNano))
    .storeBit(1) // forward_payload = Either right (^Cell)
    .storeRef(forwardCell);

  return encodeCellsBoc(root);
}

/** Ready-to-sign TON Connect 2.0 tx for staking A9 via user's A9 JettonWallet */
export function buildV15StakeTx({
  userJettonWallet,
  roundController,
  userAddress,
  amountA9Raw,
  roundId,
  queryId = BigInt(Date.now()),
  protocolVersion = 'v16',
}) {
  if (!userJettonWallet) throw new Error('userJettonWallet is required');
  return {
    validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [
      {
        address: userJettonWallet,
        amount: V15_GAS.STAKE_TOTAL_NANO,
        payload: encodeStakeJettonTransferBoc({
          roundController,
          responseDestination: userAddress,
          amountA9Raw,
          roundId,
          queryId,
          protocolVersion,
        }),
      },
    ],
  };
}

/** Ready-to-sign TON Connect 2.0 tx for claiming principal + unlocked rewards from StakeTicket */
export function buildV15ClaimTx(ticketAddress, queryId = BigInt(Date.now())) {
  if (!ticketAddress) throw new Error('ticketAddress is required');
  return {
    validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [
      {
        address: ticketAddress,
        amount: V15_GAS.CLAIM_NANO,
        payload: encodeTicketClaimBoc(queryId),
      },
    ],
  };
}

/** Ready-to-sign TON Connect 2.0 tx for 0-contract promo hot-wallet claim (user pays 0.06 GRAM) */
export function buildV15PromoFeeTx({ payTo, feeRequiredNano = V15_GAS.PROMO_FEE_NANO, memo }) {
  if (!payTo) throw new Error('payTo (promo hot wallet address) is required');
  if (!memo || !String(memo).startsWith('claim:')) throw new Error('valid claim:<id> memo is required');
  return {
    validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [
      {
        address: payTo,
        amount: String(feeRequiredNano),
        payload: encodeTextCommentBoc(memo),
      },
    ],
  };
}

/** Ready-to-sign TON Connect 2.0 tx for 0-contract A9 fixed-rate exchange (1 GRAM = 2,002 A9) */
export function buildV15PresaleTx({ payTo, tonNano, memo }) {
  if (!payTo) throw new Error('payTo (presale hot wallet address) is required');
  if (!memo || !String(memo).startsWith('buy:')) throw new Error('valid buy:<orderId> memo is required');
  if (BigInt(tonNano || 0) <= 0n) throw new Error('tonNano must be positive');
  return {
    validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [
      {
        address: payTo,
        amount: String(tonNano),
        payload: encodeTextCommentBoc(memo),
      },
    ],
  };
}
