// A9 Protocol v15 — Zero-dependency TonCenter v2/v3 HTTP client for live chain sync & inbound fee polling.

export class TonCenterClient {
  constructor({ apiBase, apiKey = '', fetchImpl = globalThis.fetch, minIntervalMs = null, maxRetries = 3 } = {}) {
    if (!apiBase) throw new Error('TONCENTER_API_BASE is required');
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.minIntervalMs = minIntervalMs ?? (apiKey ? 0 : 1100);
    this.maxRetries = maxRetries;
    this._lastReqAt = 0;
  }

  async _request(path, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (this.minIntervalMs > 0) {
        const wait = this.minIntervalMs - (Date.now() - this._lastReqAt);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      this._lastReqAt = Date.now();
      const res = await this.fetch(`${this.apiBase}${path}`, { ...options, headers });
      if (res.ok) return await res.json();
      if ((res.status === 429 || res.status === 503) && attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      throw new Error(`TonCenter HTTP ${res.status} on ${path}`);
    }
    throw new Error(`TonCenter request exhausted retries on ${path}`);
  }

  /** Call a TON get-method via TonCenter v2 /runGetMethod and return stack array. */
  async runGetMethod(address, method, stack = []) {
    const body = await this._request('/runGetMethod', {
      method: 'POST',
      body: JSON.stringify({ address, method, stack }),
    });
    if (!body?.ok || body?.result?.exit_code !== 0) {
      throw new Error(`runGetMethod ${method} failed (exit=${body?.result?.exit_code})`);
    }
    return body.result.stack || [];
  }

  /** Parse num entry from TonCenter stack: ['num', '0x...' | '-0x...'] -> BigInt */
  static parseNum(item) {
    if (!Array.isArray(item) || item[0] !== 'num') return 0n;
    const raw = String(item[1] || '0').trim();
    if (raw.startsWith('-0x') || raw.startsWith('-0X')) {
      return -BigInt(raw.slice(1));
    }
    return BigInt(raw);
  }

  /** Read v15 RoundController.get_protocol_state() directly from chain. */
  async fetchProtocolState(roundControllerAddress) {
    const s = await this.runGetMethod(roundControllerAddress, 'get_protocol_state');
    return {
      currentRoundId: Number(TonCenterClient.parseNum(s[0])),
      successCount: Number(TonCenterClient.parseNum(s[1])),
      poolRemainingRaw: TonCenterClient.parseNum(s[2]).toString(),
      carryRaw: TonCenterClient.parseNum(s[3]).toString(),
      teamPoolRemainingRaw: TonCenterClient.parseNum(s[4]).toString(),
      teamCarryRaw: TonCenterClient.parseNum(s[5]).toString(),
      lastSuccessAt: Number(TonCenterClient.parseNum(s[6])),
      endAt: Number(TonCenterClient.parseNum(s[7])),
      activeLockedRounds: Number(TonCenterClient.parseNum(s[8])),
    };
  }

  /** Read v15 RoundController.get_round(roundId) directly from chain. */
  async fetchRound(roundControllerAddress, roundId) {
    const s = await this.runGetMethod(roundControllerAddress, 'get_round', [['num', String(roundId)]]);
    return {
      status: Number(TonCenterClient.parseNum(s[0])),
      targetPriceUsdE8: TonCenterClient.parseNum(s[1]).toString(),
      twap24hUsdE8: TonCenterClient.parseNum(s[2]).toString(),
      stakeOpenAt: Number(TonCenterClient.parseNum(s[3])),
      stakeCloseAt: Number(TonCenterClient.parseNum(s[4])),
      settledAt: Number(TonCenterClient.parseNum(s[5])),
      totalStakeRaw: TonCenterClient.parseNum(s[6]).toString(),
      totalWeightRaw: TonCenterClient.parseNum(s[7]).toString(),
      rewardBudgetRaw: TonCenterClient.parseNum(s[8]).toString(),
      qualifiedCandles: Number(TonCenterClient.parseNum(s[9])),
      candleHash: `0x${TonCenterClient.parseNum(s[10]).toString(16)}`,
      immediateBps: Number(TonCenterClient.parseNum(s[11])),
      lockedSlices: Number(TonCenterClient.parseNum(s[12])),
      unlockedSlices: Number(TonCenterClient.parseNum(s[13])),
      burnedSlices: Number(TonCenterClient.parseNum(s[14])),
      lockedTotalRaw: TonCenterClient.parseNum(s[15]).toString(),
      stakeCount: Number(TonCenterClient.parseNum(s[16])),
    };
  }

  /**
   * Fetch recent finalized inbound TON transfers to a hot wallet (promo or presale).
   * Normalizes each transaction to { txHash, finality, to, from, valueNano, memo, utime }.
   */
  async fetchInboundTransfers(hotWalletAddress, limit = 30) {
    const q = new URLSearchParams({ address: hotWalletAddress, limit: String(limit), archival: 'false' });
    const body = await this._request(`/getTransactions?${q.toString()}`, { method: 'GET' });
    if (!body?.ok || !Array.isArray(body.result)) return [];
    const out = [];
    for (const tx of body.result) {
      const inMsg = tx.in_msg;
      if (!inMsg || !inMsg.source) continue;
      const hash = tx.transaction_id?.hash;
      if (!hash) continue;
      const memo = typeof inMsg.message === 'string' ? inMsg.message.trim() : '';
      out.push({
        txHash: hash,
        finality: 'finalized',
        to: hotWalletAddress,
        from: inMsg.source,
        valueNano: String(inMsg.value || '0'),
        memo,
        utime: Number(tx.utime || 0),
      });
    }
    return out;
  }

  /** Resolve a user's JettonWallet address & raw A9 balance from JettonMaster. */
  async fetchUserJettonWallet(jettonMasterAddress, ownerAddress) {
    const ownerBoc = encodeAddressSliceBoc(ownerAddress);
    const s = await this.runGetMethod(jettonMasterAddress, 'get_wallet_address', [['tvm.Slice', ownerBoc]]);
    const jwAddr = decodeAddressFromStackItem(s[0]);
    if (!jwAddr) return { jettonWallet: null, a9BalanceRaw: '0' };
    try {
      const wd = await this.runGetMethod(jwAddr, 'get_wallet_data');
      return { jettonWallet: jwAddr, a9BalanceRaw: TonCenterClient.parseNum(wd[0]).toString() };
    } catch {
      return { jettonWallet: jwAddr, a9BalanceRaw: '0' };
    }
  }

  /** Resolve a user's StakeTicket address & on-chain state for a given roundId. */
  async fetchUserTicket(roundControllerAddress, ownerAddress, roundId) {
    const ownerBoc = encodeAddressSliceBoc(ownerAddress);
    const s = await this.runGetMethod(roundControllerAddress, 'get_ticket_address', [
      ['tvm.Slice', ownerBoc],
      ['num', String(roundId)],
    ]);
    const ticketAddr = decodeAddressFromStackItem(s[0]);
    if (!ticketAddr) return null;
    try {
      const td = await this.runGetMethod(ticketAddr, 'get_ticket_data');
      return {
        ticketAddress: ticketAddr,
        roundId: Number(TonCenterClient.parseNum(td[2])),
        amountRaw: TonCenterClient.parseNum(td[3]).toString(),
        weightRaw: TonCenterClient.parseNum(td[4]).toString(),
        principalDone: TonCenterClient.parseNum(td[5]) !== 0n,
        immediateClaimed: TonCenterClient.parseNum(td[6]) !== 0n,
        lockedClaimedRaw: TonCenterClient.parseNum(td[7]).toString(),
        pending: TonCenterClient.parseNum(td[8]) !== 0n,
      };
    } catch {
      return null; // ticket not deployed for this round
    }
  }

  /** Read user's on-chain JettonWallet, A9 balance, and active StakeTickets across roundIds. */
  async fetchUserPortfolio(ownerAddress, { jettonMasterAddress = null, roundControllerAddress = null, roundIds = [] } = {}) {
    let jettonWallet = null;
    let a9BalanceRaw = '0';
    if (jettonMasterAddress) {
      try {
        const jw = await this.fetchUserJettonWallet(jettonMasterAddress, ownerAddress);
        jettonWallet = jw.jettonWallet;
        a9BalanceRaw = jw.a9BalanceRaw;
      } catch {
        // leave default if unreachable
      }
    }
    const tickets = [];
    if (roundControllerAddress && Array.isArray(roundIds)) {
      for (const rId of roundIds) {
        try {
          const t = await this.fetchUserTicket(roundControllerAddress, ownerAddress, rId);
          if (t && BigInt(t.amountRaw) > 0n) tickets.push(t);
        } catch {
          // ignore uninitialized ticket
        }
      }
    }
    return { jettonWallet, a9BalanceRaw, tickets };
  }
}

// ---------------------------------------------------------------------------
// Zero-dependency TON Address <-> 1-Cell BOC helpers (for TonCenter runGetMethod)
// ---------------------------------------------------------------------------
function crc16Ccitt(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b += 1) {
      crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xffff) : ((crc << 1) & 0xffff);
    }
  }
  return crc;
}

export function parseTonAddress(addr) {
  const s = String(addr || '').trim();
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(s)) {
    const [wcStr, hex] = s.split(':');
    return { wc: Number(wcStr), hash: Buffer.from(hex, 'hex') };
  }
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 36) throw new Error(`Invalid TON address: ${addr}`);
  const expected = crc16Ccitt(raw.subarray(0, 34));
  const actual = (raw[34] << 8) | raw[35];
  if (expected !== actual) throw new Error(`Invalid TON address CRC: ${addr}`);
  const wc = raw[1] > 127 ? raw[1] - 256 : raw[1];
  return { wc, hash: raw.subarray(2, 34) };
}

export function formatFriendlyAddress(wc, hash, { bounceable = true, testnet = false } = {}) {
  const out = Buffer.alloc(36);
  out[0] = (bounceable ? 0x11 : 0x51) | (testnet ? 0x80 : 0x00);
  out[1] = wc & 0xff;
  hash.copy(out, 2, 0, 32);
  const crc = crc16Ccitt(out.subarray(0, 34));
  out[34] = (crc >> 8) & 0xff;
  out[35] = crc & 0xff;
  return out.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function encodeAddressSliceBoc(addr) {
  const { wc, hash } = parseTonAddress(addr);
  const wcByte = wc & 0xff;
  const data = Buffer.alloc(34);
  data[0] = 0x80 | ((wcByte >>> 3) & 0x1f);
  data[1] = ((wcByte & 0x07) << 5) | (hash[0] >>> 3);
  for (let i = 0; i < 31; i += 1) {
    data[i + 2] = ((hash[i] & 0x07) << 5) | (hash[i + 1] >>> 3);
  }
  data[33] = ((hash[31] & 0x07) << 5) | 0x10;
  // Single-cell BOC: magic(4) + flags(1) + offBytes(1) + cells(1) + roots(1) + absent(1) + totSize(1) + rootIdx(1) + cell(2+34)
  const header = Buffer.from([0xb5, 0xee, 0x9c, 0x72, 0x01, 0x01, 0x01, 0x01, 0x00, 0x24, 0x00, 0x00, 0x43]);
  return Buffer.concat([header, data]).toString('base64');
}

export function decodeAddressFromCellBoc(b64, { testnet = false } = {}) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 15 || buf[0] !== 0xb5 || buf[1] !== 0xee || buf[2] !== 0x9c || buf[3] !== 0x72) {
    return null;
  }
  const flags = buf[4];
  const hasIdx = (flags & 0x80) !== 0;
  const sizeBytes = flags & 0x07;
  const offBytes = buf[5];
  let pos = 6;
  const readUint = (n) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = (v << 8) | buf[pos + i];
    pos += n;
    return v;
  };
  const cells = readUint(sizeBytes);
  const roots = readUint(sizeBytes);
  readUint(sizeBytes); // absent
  readUint(offBytes);  // totCellsSize
  pos += roots * sizeBytes;
  if (hasIdx) pos += cells * offBytes;
  if (pos + 2 >= buf.length) return null;
  const d2 = buf[pos + 1];
  const dataLen = Math.ceil(d2 / 2);
  const data = buf.subarray(pos + 2, pos + 2 + dataLen);
  if (data.length < 34 || (data[0] >>> 5) !== 0b100) return null;
  const wcByte = ((data[0] & 0x1f) << 3) | (data[1] >>> 5);
  const wc = wcByte > 127 ? wcByte - 256 : wcByte;
  const hash = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 1) {
    hash[i] = ((data[i + 1] & 0x1f) << 3) | (data[i + 2] >>> 5);
  }
  return formatFriendlyAddress(wc, hash, { bounceable: true, testnet });
}

function decodeAddressFromStackItem(item) {
  if (!Array.isArray(item)) return null;
  if ((item[0] === 'cell' || item[0] === 'slice') && item[1]?.bytes) {
    return decodeAddressFromCellBoc(item[1].bytes);
  }
  return null;
}
