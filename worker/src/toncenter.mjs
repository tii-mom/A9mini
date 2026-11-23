// A9 Protocol v15 — Zero-dependency TonCenter v2/v3 HTTP client for live chain sync & inbound fee polling.

const VALID_ACCOUNT_STATES = new Set(['active', 'uninitialized', 'frozen']);

export class TonCenterClient {
  constructor({ apiBase, apiKey = '', fetchImpl = globalThis.fetch, minIntervalMs = null, maxRetries = 3, timeoutMs = 8000 } = {}) {
    if (!apiBase) throw new Error('TONCENTER_API_BASE is required');
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.minIntervalMs = minIntervalMs ?? (apiKey ? 0 : 1100);
    this.maxRetries = maxRetries;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 8000;
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
      const signal = options.signal || (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(this.timeoutMs) : undefined);
      const res = await this.fetch(`${this.apiBase}${path}`, { ...options, headers, ...(signal ? { signal } : {}) });
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
      const err = new Error(`runGetMethod ${method} failed (exit=${body?.result?.exit_code})`);
      if (body?.ok && body?.result && typeof body.result.exit_code === 'number') {
        err.isTvmError = true;
        err.exitCode = body.result.exit_code;
      }
      throw err;
    }
    if (!Array.isArray(body.result.stack)) {
      throw new Error(`runGetMethod ${method} returned invalid stack`);
    }
    return body.result.stack;
  }

  /** Read a deployed wallet's ed25519 public key (get_public_key) as 64-char hex, or null. */
  async fetchWalletPublicKey(walletAddress) {
    const s = await this.runGetMethod(walletAddress, 'get_public_key');
    const n = TonCenterClient.parseStrictNum(s[0], { allowNegative: false });
    if (n === null || n <= 0n) return null;
    return n.toString(16).padStart(64, '0');
  }

  /**
   * 读取链上账户活跃状态与当前已部署代码 BoC（供 WalletTg 校验及未部署账户判零核查使用）。
   * 严格要求 body.result.state 存在且属于已知状态（active / uninitialized / frozen），
   * 缺失或非法时显式抛错，绝不默认当作 uninitialized。
   */
  async fetchWalletAccountState(walletAddress) {
    const q = new URLSearchParams({ address: walletAddress });
    const body = await this._request(`/getAddressInformation?${q.toString()}`, { method: 'GET' });
    if (!body?.ok || !body?.result || typeof body.result !== 'object') {
      throw new Error('getAddressInformation returned invalid response');
    }
    const rawState = typeof body.result.state === 'string' ? body.result.state.trim() : '';
    if (!VALID_ACCOUNT_STATES.has(rawState)) {
      throw new Error(`getAddressInformation missing or invalid account state: ${rawState || '<empty>'}`);
    }
    return {
      state: rawState,
      codeBoc: typeof body.result.code === 'string' && body.result.code.length > 0 ? body.result.code : null,
    };
  }

  /**
   * 严格解析 TonCenter stack 中的数值项 ['num', '0x...' | '-0x...' | '123'] -> BigInt | null。
   * 缺失、类型错误、空字符串、非法格式或不允许负数时返回 null（绝不静默当 0n）。
   */
  static parseStrictNum(item, { allowNegative = false } = {}) {
    if (!Array.isArray(item) || item.length < 2 || item[0] !== 'num' || typeof item[1] !== 'string') {
      return null;
    }
    const raw = item[1].trim();
    if (!raw || !/^-?(?:0[xX][0-9a-fA-F]+|\d+)$/.test(raw)) return null;
    let val;
    try {
      val = (raw.startsWith('-0x') || raw.startsWith('-0X'))
        ? -BigInt(raw.slice(1))
        : BigInt(raw);
    } catch {
      return null;
    }
    if (!allowNegative && val < 0n) return null;
    return val;
  }

  /** Parse num entry from TonCenter stack: ['num', '0x...' | '-0x...'] -> BigInt */
  static parseNum(item) {
    const parsed = TonCenterClient.parseStrictNum(item, { allowNegative: true });
    return parsed === null ? 0n : parsed;
  }

  /** Read v15 RoundController.get_protocol_state() directly from chain. */
  async fetchProtocolState(roundControllerAddress) {
    const s = await this.runGetMethod(roundControllerAddress, 'get_protocol_state');
    const activeLockedRounds = TonCenterClient.parseNum(s[8]);
    return {
      currentRoundId: Number(TonCenterClient.parseNum(s[0])),
      successCount: Number(TonCenterClient.parseNum(s[1])),
      poolRemainingRaw: TonCenterClient.parseNum(s[2]).toString(),
      carryRaw: TonCenterClient.parseNum(s[3]).toString(),
      teamPoolRemainingRaw: TonCenterClient.parseNum(s[4]).toString(),
      teamCarryRaw: TonCenterClient.parseNum(s[5]).toString(),
      lastSuccessAt: Number(TonCenterClient.parseNum(s[6])),
      endAt: Number(TonCenterClient.parseNum(s[7])),
      activeLockedRounds: activeLockedRounds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(activeLockedRounds) : null,
      activeLockedRoundsRaw: activeLockedRounds.toString(),
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

  /**
   * Verify an outbound payout transaction from a hot wallet via TonCenter /getTransactions.
   * Matches by exact txHash (hex or base64) and inspects out_msgs presence to confirm execution.
   */
  async verifyOutboundPayout(hotWalletAddress, payout, limit = 40) {
    if (!hotWalletAddress || !payout?.txHash) return { state: 'PENDING' };
    const q = new URLSearchParams({ address: hotWalletAddress, limit: String(limit), archival: 'false' });
    const body = await this._request(`/getTransactions?${q.toString()}`, { method: 'GET' });
    if (!body?.ok || !Array.isArray(body.result)) return { state: 'PENDING' };
    const target = String(payout.txHash).replace(/^0x/i, '').toLowerCase();
    for (const tx of body.result) {
      const rawHash = String(tx.transaction_id?.hash || '');
      const hexHash = rawHash ? Buffer.from(rawHash, 'base64').toString('hex').toLowerCase() : '';
      if (rawHash.toLowerCase() === target || hexHash === target) {
        const hasOut = Array.isArray(tx.out_msgs) && tx.out_msgs.length > 0;
        return hasOut ? { state: 'CONFIRMED', txHash: rawHash } : { state: 'FAILED', txHash: rawHash };
      }
    }
    return { state: 'PENDING' };
  }

  /**
   * 解析用户 JettonWallet 地址与 A9 链上余额（P0-G）。
   * 仅在 get_wallet_data 成功，或通过 /getAddressInformation 明确核实合约处于 uninitialized（未部署）时
   * 才返回具体余额（含真实 '0'）；任何 HTTP/网络/RPC 故障或 active 合约调用失败一律返回 a9BalanceRaw: null, balanceAvailable: false。
   */
  async fetchUserJettonWallet(jettonMasterAddress, ownerAddress) {
    const ownerBoc = encodeAddressSliceBoc(ownerAddress);
    const s = await this.runGetMethod(jettonMasterAddress, 'get_wallet_address', [['tvm.Slice', ownerBoc]]);
    if (!Array.isArray(s) || s.length < 1) {
      return { jettonWallet: null, a9BalanceRaw: null, balanceAvailable: false };
    }
    const jwAddr = decodeAddressFromStackItem(s[0]);
    if (!jwAddr) return { jettonWallet: null, a9BalanceRaw: null, balanceAvailable: false };
    try {
      const wd = await this.runGetMethod(jwAddr, 'get_wallet_data');
      // 严格校验结果栈非空且余额字段为合法非负数值项（缺失/空栈/类型错误绝不解释为 0）。
      if (!Array.isArray(wd) || wd.length < 1) {
        return { jettonWallet: jwAddr, a9BalanceRaw: null, balanceAvailable: false };
      }
      const balance = TonCenterClient.parseStrictNum(wd[0], { allowNegative: false });
      if (balance === null) {
        return { jettonWallet: jwAddr, a9BalanceRaw: null, balanceAvailable: false };
      }
      return {
        jettonWallet: jwAddr,
        a9BalanceRaw: balance.toString(),
        balanceAvailable: true,
      };
    } catch (err) {
      if (err?.isTvmError) {
        try {
          const info = await this.fetchWalletAccountState(jwAddr);
          if (info?.state === 'uninitialized') {
            return { jettonWallet: jwAddr, a9BalanceRaw: '0', balanceAvailable: true };
          }
        } catch {
          // 账户状态查询失败或缺少 state 字段时绝不能假定余额为 0
        }
      }
      return { jettonWallet: jwAddr, a9BalanceRaw: null, balanceAvailable: false };
    }
  }

  /** Resolve a user's StakeTicket address & on-chain state for a given roundId. */
  async fetchUserTicket(roundControllerAddress, ownerAddress, roundId) {
    const ownerBoc = encodeAddressSliceBoc(ownerAddress);
    const s = await this.runGetMethod(roundControllerAddress, 'get_ticket_address', [
      ['tvm.Slice', ownerBoc],
      ['num', String(roundId)],
    ]);
    if (!Array.isArray(s) || s.length < 1) throw new Error('get_ticket_address returned empty stack');
    const ticketAddr = decodeAddressFromStackItem(s[0]);
    if (!ticketAddr) throw new Error('get_ticket_address returned invalid address');
    try {
      const td = await this.runGetMethod(ticketAddr, 'get_ticket_data');
      if (!Array.isArray(td) || td.length < 9) {
        throw new Error('get_ticket_data returned incomplete stack');
      }
      const parsedRoundId = TonCenterClient.parseStrictNum(td[2], { allowNegative: false });
      const amountRaw = TonCenterClient.parseStrictNum(td[3], { allowNegative: false });
      const weightRaw = TonCenterClient.parseStrictNum(td[4], { allowNegative: false });
      const principalDone = TonCenterClient.parseStrictNum(td[5], { allowNegative: true });
      const immediateClaimed = TonCenterClient.parseStrictNum(td[6], { allowNegative: true });
      const lockedClaimedRaw = TonCenterClient.parseStrictNum(td[7], { allowNegative: false });
      const pending = TonCenterClient.parseStrictNum(td[8], { allowNegative: true });
      if (
        parsedRoundId === null || amountRaw === null || weightRaw === null ||
        principalDone === null || immediateClaimed === null || lockedClaimedRaw === null || pending === null
      ) {
        throw new Error('get_ticket_data returned malformed field types');
      }
      return {
        ticketAddress: ticketAddr,
        roundId: Number(parsedRoundId),
        amountRaw: amountRaw.toString(),
        weightRaw: weightRaw.toString(),
        principalDone: principalDone !== 0n,
        immediateClaimed: immediateClaimed !== 0n,
        lockedClaimedRaw: lockedClaimedRaw.toString(),
        pending: pending !== 0n,
      };
    } catch (err) {
      if (err?.isTvmError) {
        const info = await this.fetchWalletAccountState(ticketAddr);
        if (info?.state === 'uninitialized') return null; // 该轮凭证合约确实未部署
      }
      throw err;
    }
  }

  /**
   * 读取用户链上 JettonWallet、A9 余额与活跃 StakeTicket（P0-G）。
   * 链上未配置或请求失败时严格返回 a9BalanceRaw: null 与 balanceAvailable: false，绝不将查询失败显示为余额 0。
   */
  async fetchUserPortfolio(ownerAddress, { jettonMasterAddress = null, roundControllerAddress = null, roundIds = [] } = {}) {
    let jettonWallet = null;
    let a9BalanceRaw = null;
    let balanceAvailable = false;
    if (jettonMasterAddress) {
      try {
        const jw = await this.fetchUserJettonWallet(jettonMasterAddress, ownerAddress);
        jettonWallet = jw.jettonWallet;
        a9BalanceRaw = jw.a9BalanceRaw;
        balanceAvailable = Boolean(jw.balanceAvailable);
      } catch {
        jettonWallet = null;
        a9BalanceRaw = null;
        balanceAvailable = false;
      }
    }
    const tickets = [];
    let ticketsAvailable = Boolean(roundControllerAddress);
    if (roundControllerAddress && Array.isArray(roundIds)) {
      for (const rId of roundIds) {
        try {
          const t = await this.fetchUserTicket(roundControllerAddress, ownerAddress, rId);
          if (t && BigInt(t.amountRaw) > 0n) tickets.push(t);
        } catch {
          ticketsAvailable = false;
        }
      }
    }
    const onchainAvailable = Boolean(
      (jettonMasterAddress || roundControllerAddress) &&
      (!jettonMasterAddress || balanceAvailable) &&
      (!roundControllerAddress || ticketsAvailable),
    );
    return { jettonWallet, a9BalanceRaw, balanceAvailable, tickets, ticketsAvailable, onchainAvailable };
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
