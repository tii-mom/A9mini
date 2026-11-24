// A9 Protocol v15/v16 — Zero-dependency TonCenter v2/v3 HTTP client for live chain sync,
// cursor-paginated inbound scanning & downstream payout verification.
import { addressKey } from './ton-address.mjs';

const VALID_ACCOUNT_STATES = new Set(['active', 'uninitialized', 'frozen']);

function deriveV3Base(v2Base) {
  const clean = String(v2Base || '').replace(/\/+$/, '');
  if (/\/api\/v3$/i.test(clean)) return clean;
  if (/\/api\/v2$/i.test(clean)) return clean.replace(/\/api\/v2$/i, '/api/v3');
  return `${clean}/v3`;
}

export class TonCenterClient {
  constructor({ apiBase, v3ApiBase = null, apiKey = '', testnet = false, preferV3Inbound = null, fetchImpl = globalThis.fetch, minIntervalMs = null, maxRetries = 3, timeoutMs = 8000 } = {}) {
    if (!apiBase) throw new Error('TONCENTER_API_BASE is required');
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.v3ApiBase = v3ApiBase ? String(v3ApiBase).replace(/\/+$/, '') : deriveV3Base(this.apiBase);
    this.apiKey = apiKey;
    this.testnet = Boolean(testnet) || /testnet/i.test(this.apiBase);
    // 真实 TonCenter 节点优先使用基于索引库的 v3 /transactions 扫链，避免 v2 archival=false 命中剪枝块报 HTTP 500 并提供真实 mc_block_seqno 终局性
    this.preferV3Inbound = preferV3Inbound !== null ? Boolean(preferV3Inbound) : /toncenter\.com/i.test(this.apiBase);
    // Cloudflare workerd 禁止将 globalThis.fetch 挂载到实例上以 this.fetch(...) 方式调用（会触发 Illegal invocation）
    this.fetch = fetchImpl === globalThis.fetch && typeof globalThis.fetch === 'function'
      ? (...args) => globalThis.fetch(...args)
      : fetchImpl;
    this.minIntervalMs = minIntervalMs ?? (apiKey ? 0 : 1100);
    this.maxRetries = maxRetries;
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 8000;
    this._nextAllowedAt = 0;
  }

  async _requestUrl(fullUrl, pathLabel, options = {}) {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (this.minIntervalMs > 0) {
        const now = Date.now();
        const slot = Math.max(now, this._nextAllowedAt);
        this._nextAllowedAt = slot + this.minIntervalMs;
        const wait = slot - now;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      const signal = options.signal || (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(this.timeoutMs) : undefined);
      let res;
      try {
        res = await this.fetch(fullUrl, { ...options, headers, ...(signal ? { signal } : {}) });
      } catch (e) {
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        throw new Error(`TonCenter network/timeout error on ${pathLabel}: ${e?.message || e}`);
      }
      if (res.ok) {
        try {
          return await res.json();
        } catch (e) {
          if (attempt < this.maxRetries) {
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            continue;
          }
          throw new Error(`TonCenter JSON parse error on ${pathLabel}: ${e?.message || e}`);
        }
      }
      try { res.body?.cancel?.(); } catch {}
      if ((res.status === 429 || res.status === 503) && attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      if ((res.status === 500 || res.status === 502 || res.status === 504 || res.status === 542) && attempt < this.maxRetries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
      }
      throw new Error(`TonCenter HTTP ${res.status} on ${pathLabel}`);
    }
    throw new Error(`TonCenter request exhausted retries on ${pathLabel}`);
  }

  async _request(path, options = {}) {
    return this._requestUrl(`${this.apiBase}${path}`, path, options);
  }

  async _requestV3(path, options = {}) {
    return this._requestUrl(`${this.v3ApiBase}${path}`, `v3:${path}`, options);
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

  /** Read v15/v16 RoundController.get_protocol_state() directly from chain (strict stack validation). */
  async fetchProtocolState(roundControllerAddress) {
    const s = await this.runGetMethod(roundControllerAddress, 'get_protocol_state');
    if (!Array.isArray(s) || s.length < 9) {
      throw new Error(`get_protocol_state returned truncated stack (len=${s?.length ?? 0})`);
    }
    const reqNum = (idx, label) => {
      const v = TonCenterClient.parseStrictNum(s[idx], { allowNegative: false });
      if (v === null) throw new Error(`get_protocol_state invalid ${label} at stack[${idx}]`);
      return v;
    };
    const activeLockedRounds = reqNum(8, 'activeLockedRounds');
    return {
      currentRoundId: Number(reqNum(0, 'currentRoundId')),
      successCount: Number(reqNum(1, 'successCount')),
      poolRemainingRaw: reqNum(2, 'poolRemainingRaw').toString(),
      carryRaw: reqNum(3, 'carryRaw').toString(),
      teamPoolRemainingRaw: reqNum(4, 'teamPoolRemainingRaw').toString(),
      teamCarryRaw: reqNum(5, 'teamCarryRaw').toString(),
      lastSuccessAt: Number(reqNum(6, 'lastSuccessAt')),
      endAt: Number(reqNum(7, 'endAt')),
      activeLockedRounds: activeLockedRounds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(activeLockedRounds) : null,
      activeLockedRoundsRaw: activeLockedRounds.toString(),
    };
  }

  /** Read v15/v16 RoundController.get_round(roundId) directly from chain (strict stack validation). */
  async fetchRound(roundControllerAddress, roundId) {
    const s = await this.runGetMethod(roundControllerAddress, 'get_round', [['num', String(roundId)]]);
    if (!Array.isArray(s) || s.length < 17) {
      throw new Error(`get_round(${roundId}) returned truncated stack (len=${s?.length ?? 0})`);
    }
    const reqNum = (idx, label) => {
      const v = TonCenterClient.parseStrictNum(s[idx], { allowNegative: false });
      if (v === null) throw new Error(`get_round(${roundId}) invalid ${label} at stack[${idx}]`);
      return v;
    };
    return {
      status: Number(reqNum(0, 'status')),
      targetPriceUsdE8: reqNum(1, 'targetPriceUsdE8').toString(),
      twap24hUsdE8: reqNum(2, 'twap24hUsdE8').toString(),
      stakeOpenAt: Number(reqNum(3, 'stakeOpenAt')),
      stakeCloseAt: Number(reqNum(4, 'stakeCloseAt')),
      settledAt: Number(reqNum(5, 'settledAt')),
      totalStakeRaw: reqNum(6, 'totalStakeRaw').toString(),
      totalWeightRaw: reqNum(7, 'totalWeightRaw').toString(),
      rewardBudgetRaw: reqNum(8, 'rewardBudgetRaw').toString(),
      qualifiedCandles: Number(reqNum(9, 'qualifiedCandles')),
      candleHash: `0x${reqNum(10, 'candleHash').toString(16).padStart(64, '0')}`,
      immediateBps: Number(reqNum(11, 'immediateBps')),
      lockedSlices: Number(reqNum(12, 'lockedSlices')),
      unlockedSlices: Number(reqNum(13, 'unlockedSlices')),
      burnedSlices: Number(reqNum(14, 'burnedSlices')),
      lockedTotalRaw: reqNum(15, 'lockedTotalRaw').toString(),
      stakeCount: Number(reqNum(16, 'stakeCount')),
    };
  }

  /**
   * 规范化单条 TonCenter v2 交易记录。
   * 仅当未发生 bounced/aborted 且具备完整 txHash 时作为有效入账候选。
   */
  _normalizeInboundTx(tx, hotWalletAddress, { requireMasterchainFinality = false } = {}) {
    const inMsg = tx?.in_msg;
    if (!inMsg || !inMsg.source) return null;
    const hash = tx.transaction_id?.hash;
    if (!hash) return null;
    const lt = tx.transaction_id?.lt ? String(tx.transaction_id.lt) : null;
    const memo = typeof inMsg.message === 'string' ? inMsg.message.trim() : '';
    const mcConfirmed = tx.finality === 'finalized'
      || Number(tx.mc_block_seqno || 0) > 0
      || (tx.finality === undefined && !requireMasterchainFinality);
    return {
      txHash: hash,
      lt,
      finality: mcConfirmed ? 'finalized' : 'pending',
      to: inMsg.destination || hotWalletAddress,
      from: inMsg.source,
      valueNano: String(inMsg.value || '0'),
      memo,
      bounced: Boolean(inMsg.bounced),
      aborted: Boolean(tx.description?.aborted),
      utime: Number(tx.utime || 0),
    };
  }

  /**
   * Fetch recent inbound TON transfers to a hot wallet (promo or presale).
   * Preserves real destination, bounced, and aborted flags so failed bouncebacks
   * are never mistaken for new customer deposits.
   */
  async fetchInboundTransfers(hotWalletAddress, limit = 30) {
    const q = new URLSearchParams({ address: hotWalletAddress, limit: String(limit), archival: 'false' });
    const body = await this._request(`/getTransactions?${q.toString()}`, { method: 'GET' });
    if (!body?.ok || !Array.isArray(body.result)) return [];
    const out = [];
    for (const tx of body.result) {
      const norm = this._normalizeInboundTx(tx, hotWalletAddress);
      if (norm) out.push(norm);
    }
    return out;
  }

  _normalizeV3InboundTx(tx, hotWalletAddress, { requireMasterchainFinality = true } = {}) {
    const inMsg = tx?.in_msg;
    if (!inMsg || !inMsg.source || !tx?.hash || !tx?.lt) return null;
    if (tx?.emulated === true) return null;
    if (inMsg.bounced === true) return null;
    if (tx?.description?.aborted === true) return null;
    const val = BigInt(inMsg.value || '0');
    if (val <= 0n) return null;

    const mcSeqno = Number(tx.mc_block_seqno || 0);
    const hasMcFinality = Number.isFinite(mcSeqno) && mcSeqno > 0;
    if (requireMasterchainFinality && !hasMcFinality) return null;

    let memo = '';
    const decoded = inMsg.message_content?.decoded;
    if (decoded && typeof decoded.comment === 'string') {
      memo = decoded.comment.trim();
    } else if (typeof inMsg.comment === 'string') {
      memo = inMsg.comment.trim();
    }
    return {
      txHash: String(tx.hash),
      lt: String(tx.lt),
      utime: Number(tx.now || 0),
      to: String(inMsg.destination || tx.account || hotWalletAddress),
      from: String(inMsg.source),
      valueNano: val.toString(),
      memo,
      finality: hasMcFinality ? 'finalized' : 'unconfirmed',
      mcBlockSeqno: hasMcFinality ? mcSeqno : null,
    };
  }

  async _fetchInboundTransfersSinceV3(
    hotWalletAddress,
    { cursorLt = null, cursorHash = null, pageSize = 50, maxPages = 20, requireMasterchainFinality = true } = {},
  ) {
    const stopLt = cursorLt ? BigInt(cursorLt) : null;
    const seenHashes = new Set();
    const collected = [];
    let newestCursor = null;
    let reachedCursor = stopLt === null;
    let truncated = false;

    if (stopLt !== null) {
      // 有持久游标时：必须使用 TonCenter v3 的 start_lt + sort=asc 范围增量查询。
      // 既彻底规避 offset 漂移漏单，又绕开 TonCenter v3 无边界 limit=50&sort=desc 的陈旧索引视图。
      let currentStartLt = stopLt;
      reachedCursor = true;
      for (let page = 0; page < maxPages; page += 1) {
        const params = new URLSearchParams({
          account: hotWalletAddress,
          limit: String(pageSize),
          start_lt: currentStartLt.toString(),
          sort: 'asc',
        });
        const body = await this._requestV3(`/transactions?${params.toString()}`, { method: 'GET' });
        const rows = Array.isArray(body?.transactions) ? body.transactions : [];
        if (!rows.length) break;

        let lastRowLt = null;
        let hitUnconfirmed = false;
        for (const tx of rows) {
          const hash = tx?.hash ? String(tx.hash) : null;
          const ltStr = tx?.lt ? String(tx.lt) : null;
          if (!hash || !ltStr) continue;
          const ltBig = BigInt(ltStr);
          lastRowLt = ltBig;

          // 按 lt 升序消费：一旦遇到尚未进入主链终局块的交易即停止推进，下个 tick 再确认
          const mcSeqno = Number(tx.mc_block_seqno || 0);
          if (requireMasterchainFinality && (!Number.isFinite(mcSeqno) || mcSeqno <= 0)) {
            hitUnconfirmed = true;
            break;
          }
          if (ltBig < stopLt || (ltBig === stopLt && (!cursorHash || hash === cursorHash))) {
            continue;
          }
          newestCursor = { lt: ltStr, hash };
          if (seenHashes.has(hash)) continue;
          seenHashes.add(hash);

          const norm = this._normalizeV3InboundTx(tx, hotWalletAddress, { requireMasterchainFinality });
          if (norm) collected.push(norm);
        }

        if (hitUnconfirmed || rows.length < pageSize || lastRowLt === null) break;
        const nextStart = lastRowLt + 1n;
        if (nextStart <= currentStartLt) break;
        currentStartLt = nextStart;
        if (page === maxPages - 1) truncated = true;
      }

      return {
        transfers: collected,
        nextCursor: newestCursor,
        reachedCursor,
        truncated,
        // v3 start_lt + sort=asc 按 lt 严格升序连续消费、中间绝无空洞：
        // 即使达到单次 maxPages 上限触发 truncated=true，也必须推进游标以逐批追平，杜绝死锁。
        canAdvanceCursor: Boolean(newestCursor),
      };
    }

    // 无游标冷启动：拉取最新一页（限定 limit<=30 避免 TonCenter v3 大窗口缓存陈旧），按 lt 升序返回
    const coldLimit = Math.min(pageSize, 30);
    const params = new URLSearchParams({
      account: hotWalletAddress,
      limit: String(coldLimit),
      sort: 'desc',
    });
    const body = await this._requestV3(`/transactions?${params.toString()}`, { method: 'GET' });
    const rows = Array.isArray(body?.transactions) ? body.transactions : [];
    const ascRows = rows
      .filter((tx) => tx?.hash && tx?.lt)
      .slice()
      .sort((a, b) => {
        const la = BigInt(String(a.lt));
        const lb = BigInt(String(b.lt));
        return la < lb ? -1 : (la > lb ? 1 : 0);
      });
    // 按 lt 升序定位冷启动安全游标：遇到第一笔未进入主链终局块的交易即停止推进游标，防止跳过未终局交易
    for (const tx of ascRows) {
      const hash = String(tx.hash);
      const ltStr = String(tx.lt);
      const mcSeqno = Number(tx.mc_block_seqno || 0);
      if (requireMasterchainFinality && (!Number.isFinite(mcSeqno) || mcSeqno <= 0)) {
        break;
      }
      newestCursor = { lt: ltStr, hash };
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      const norm = this._normalizeV3InboundTx(tx, hotWalletAddress, { requireMasterchainFinality });
      if (norm) collected.push(norm);
    }

    collected.sort((a, b) => {
      const la = a.lt ? BigInt(a.lt) : 0n;
      const lb = b.lt ? BigInt(b.lt) : 0n;
      if (la < lb) return -1;
      if (la > lb) return 1;
      return (a.utime || 0) - (b.utime || 0);
    });

    const coldTruncated = rows.length >= coldLimit;
    return {
      transfers: collected,
      nextCursor: newestCursor,
      reachedCursor: !coldTruncated,
      truncated: coldTruncated,
      // 冷启动阶段即使历史总交易 >= coldLimit，只要拿到了已终局的 newestCursor 就必须允许首次落库，
      // 否则游标永远无法初始化并陷入永久 30 笔窗口。
      canAdvanceCursor: Boolean(newestCursor),
    };
  }

  /**
   * 基于持久化 (lt, hash) 游标向后分页补扫全部增量入账，彻底突破 30 笔窗口上限。
   * - 真实 TonCenter 优先走索引库 v3 /transactions（抗剪枝块 500 并自带 mc_block_seqno 主链终局）；
   * - 非 TonCenter 或自定义端点先走 v2 /getTransactions，遇 HTTP 5xx 自动降级到 v3 /transactions；
   * - 按 lt 升序（由旧到新）返回增量 transfers，保证消费顺序确定。
   */
  async fetchInboundTransfersSince(
    hotWalletAddress,
    { cursorLt = null, cursorHash = null, pageSize = 50, maxPages = 20, requireMasterchainFinality = false } = {},
  ) {
    if (this.preferV3Inbound) {
      return this._fetchInboundTransfersSinceV3(hotWalletAddress, {
        cursorLt,
        cursorHash,
        pageSize,
        maxPages,
        requireMasterchainFinality: true,
      });
    }

    const stopLt = cursorLt ? BigInt(cursorLt) : null;
    const seenHashes = new Set();
    const collected = [];
    const seenAll = [];
    let pageLt = null;
    let pageHash = null;
    let reachedCursor = stopLt === null;
    let truncated = false;

    try {
      for (let page = 0; page < maxPages; page += 1) {
        const params = { address: hotWalletAddress, limit: String(pageSize), archival: 'false' };
        if (pageLt && pageHash) {
          params.lt = pageLt;
          params.hash = pageHash;
        }
        const q = new URLSearchParams(params);
        const body = await this._request(`/getTransactions?${q.toString()}`, { method: 'GET' });
        const rows = body?.ok && Array.isArray(body.result) ? body.result : [];
        if (!rows.length) {
          reachedCursor = true;
          break;
        }

        let hitBoundary = false;
        for (const tx of rows) {
          const hash = tx?.transaction_id?.hash;
          const ltStr = tx?.transaction_id?.lt ? String(tx.transaction_id.lt) : null;
          if (!hash || !ltStr) continue;

          if (stopLt !== null && (BigInt(ltStr) < stopLt || (BigInt(ltStr) === stopLt && (!cursorHash || hash === cursorHash)))) {
            hitBoundary = true;
            reachedCursor = true;
            break;
          }
          if (seenHashes.has(hash)) continue;
          seenHashes.add(hash);

          const mcConfirmed = tx.finality === 'finalized'
            || Number(tx.mc_block_seqno || 0) > 0
            || (tx.finality === undefined && !requireMasterchainFinality);
          seenAll.push({ lt: ltStr, hash, finalized: mcConfirmed });

          const norm = this._normalizeInboundTx(tx, hotWalletAddress, { requireMasterchainFinality });
          if (norm) collected.push(norm);
        }

        if (hitBoundary || rows.length < pageSize) {
          reachedCursor = true;
          break;
        }
        const oldest = rows[rows.length - 1];
        const nextLt = oldest?.transaction_id?.lt ? String(oldest.transaction_id.lt) : null;
        const nextHash = oldest?.transaction_id?.hash || null;
        if (!nextLt || !nextHash || (nextLt === pageLt && nextHash === pageHash)) {
          break;
        }
        pageLt = nextLt;
        pageHash = nextHash;
        if (page === maxPages - 1) truncated = !reachedCursor;
      }
    } catch (e) {
      if (this.v3ApiBase && /HTTP 5\d\d/.test(String(e?.message || ''))) {
        return this._fetchInboundTransfersSinceV3(hotWalletAddress, {
          cursorLt,
          cursorHash,
          pageSize,
          maxPages,
          requireMasterchainFinality: true,
        });
      }
      throw e;
    }

    // 按逻辑时间 lt 升序返回（老交易先入账），并严格计算不越过任何未终局交易的安全游标
    collected.sort((a, b) => {
      const la = a.lt ? BigInt(a.lt) : 0n;
      const lb = b.lt ? BigInt(b.lt) : 0n;
      if (la < lb) return -1;
      if (la > lb) return 1;
      return (a.utime || 0) - (b.utime || 0);
    });
    seenAll.sort((a, b) => {
      const la = BigInt(a.lt);
      const lb = BigInt(b.lt);
      return la < lb ? -1 : (la > lb ? 1 : 0);
    });
    let safeCursor = null;
    if (reachedCursor && !truncated) {
      for (const item of seenAll) {
        if (!item.finalized) break; // 绝不越过未终局交易推进游标
        safeCursor = { lt: item.lt, hash: item.hash };
      }
    }

    return {
      transfers: collected,
      nextCursor: safeCursor,
      reachedCursor,
      truncated,
      // v2 倒序回溯只有在完整接上旧游标且未截断时才无空洞，允许推进游标
      canAdvanceCursor: Boolean(safeCursor && reachedCursor && !truncated),
    };
  }

  /** 将 0x<hex1..64> / <hex64> / base64(32B) 交易哈希统一规范为 64 位小写 hex，消除前导零截断与 hex/base64 错配。 */
  static normalizeTxHashHex(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    if (/^0x[0-9a-fA-F]{1,64}$/.test(raw)) {
      return raw.slice(2).toLowerCase().padStart(64, '0');
    }
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
    try {
      const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
      let bytes;
      if (typeof Buffer !== 'undefined') {
        bytes = Buffer.from(b64, 'base64');
      } else {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      }
      if (bytes.length === 32) {
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch {}
    return raw.replace(/^0x/i, '').toLowerCase();
  }

  /**
   * 基于 TonCenter v3 下游真实链上执行结果的出账终局核验器（彻底消除外层 out_msgs 假确认）：
   * - kind === 'A9'：使用 start_utime + sort=asc 受限分页查询 v3 /jetton/transfers，避免高并发挤出窗口；
   *   先扫描全部结果匹配 CONFIRMED，再判定 FAILED；超过安全确认窗仍完全无链上记录时返回 NOT_FOUND。
   * - kind === 'REFUND'：使用 direction=in（带 source + destination）查询 v3 /messages，统一 hex/base64 哈希与 memo 比对，
   *   强制校验 in_msg_tx_hash 非空落地且非 bounced/aborted；超过安全确认窗无记录返回 NOT_FOUND。
   */
  async verifyOutboundPayout(
    hotWalletAddress,
    payout,
    { jettonMasterAddress = null, limit = 50, maxPages = 10, startUtime = null, nowSec = Math.floor(Date.now() / 1000), notFoundAfterSec = 300 } = {},
  ) {
    if (!hotWalletAddress || !payout) return { state: 'PENDING' };
    const kind = String(payout.kind || 'A9').toUpperCase();
    const targetRecipientKey = addressKey(payout.recipient);
    const targetAmount = BigInt(payout.amount || payout.jettonAmountRaw || payout.tonNano || 0);
    const targetQueryId = payout.queryId !== undefined && payout.queryId !== null ? String(payout.queryId) : null;
    const rawCreated = Number(payout.createdAt ?? payout.created_at ?? 0);
    const rawUpdated = Number(payout.updatedAt ?? payout.updated_at ?? 0);
    const normSec = (v) => (v > 1e12 ? Math.floor(v / 1000) : Math.floor(v));
    const createdSec = normSec(rawCreated);
    const updatedSec = normSec(rawUpdated);
    // 重试（attempts > 1）时新 queryId 在 updatedAt 附近发出，优先锚定 updatedAt 避免被历史 500 笔窗口挤出
    const anchorSec = (Number(payout.attempts || 0) > 1 && updatedSec > 1_000_000_000)
      ? updatedSec
      : (createdSec > 1_000_000_000 ? createdSec : updatedSec);
    const effectiveStartUtime = startUtime !== null
      ? Math.max(0, Math.floor(Number(startUtime)))
      : (anchorSec > 1_000_000_000
          ? Math.max(0, anchorSec - 300)
          : Math.max(0, Math.floor(Date.now() / 1000) - 86400));
    const canDeclareNotFound = anchorSec > 1_000_000_000 && (Number(nowSec) - anchorSec) >= Number(notFoundAfterSec || 300);

    if (kind === 'A9') {
      if (!targetQueryId) return { state: 'PENDING', reason: 'MISSING_QUERY_ID' };
      const pageSize = Math.min(Math.max(1, Number(limit) || 50), 100);
      let pendingHit = null;
      let failedHit = null;
      let truncated = false;
      for (let page = 0; page < maxPages; page += 1) {
        const params = new URLSearchParams({
          owner_address: hotWalletAddress,
          direction: 'out',
          start_utime: String(effectiveStartUtime),
          sort: 'asc',
          limit: String(pageSize),
        });
        if (page > 0) params.set('offset', String(page * pageSize));
        if (jettonMasterAddress) params.set('jetton_master', jettonMasterAddress);
        let body;
        try {
          body = await this._requestV3(`/jetton/transfers?${params.toString()}`, { method: 'GET' });
        } catch (e) {
          return { state: 'PENDING', reason: `V3_UNAVAILABLE: ${e?.message || e}` };
        }
        const transfers = Array.isArray(body?.jetton_transfers) ? body.jetton_transfers : (Array.isArray(body?.result) ? body.result : []);
        for (const tr of transfers) {
          if (String(tr.query_id ?? '') !== targetQueryId) continue;
          const destKey = addressKey(tr.destination || '');
          const amt = BigInt(tr.amount || 0);
          const aborted = Boolean(tr.transaction_aborted || tr.aborted || tr.bounced);
          const incomplete = Boolean(tr.trace_incomplete);
          const txHash = tr.transaction_hash || tr.trace_id || payout.txHash || null;
          if (!aborted && !incomplete && destKey === targetRecipientKey && amt === targetAmount) {
            return { state: 'CONFIRMED', txHash };
          }
          if (incomplete && !pendingHit) {
            pendingHit = { state: 'PENDING', txHash, reason: 'TRACE_INCOMPLETE' };
          } else if (aborted) {
            failedHit = { state: 'FAILED', txHash, reason: 'JETTON_TRANSFER_ABORTED' };
          } else if (destKey !== targetRecipientKey || amt !== targetAmount) {
            failedHit = { state: 'FAILED', txHash, reason: 'JETTON_TRANSFER_MISMATCH' };
          }
        }
        if (transfers.length < pageSize) break;
        if (page === maxPages - 1) truncated = true;
      }
      if (pendingHit) return pendingHit;
      if (failedHit) return failedHit;
      if (canDeclareNotFound && !truncated) {
        return { state: 'NOT_FOUND', reason: 'ONCHAIN_TRANSFER_NOT_FOUND' };
      }
      return { state: 'PENDING' };
    }

    if (kind === 'REFUND') {
      const params = new URLSearchParams({
        source: hotWalletAddress,
        direction: 'in',
        start_utime: String(effectiveStartUtime),
        sort: 'desc',
        limit: String(limit),
      });
      if (payout.recipient) params.set('destination', payout.recipient);
      let body;
      try {
        body = await this._requestV3(`/messages?${params.toString()}`, { method: 'GET' });
      } catch (e) {
        return { state: 'PENDING', reason: `V3_UNAVAILABLE: ${e?.message || e}` };
      }
      const msgs = Array.isArray(body?.messages) ? body.messages : (Array.isArray(body?.result) ? body.result : []);
      const expectedMemo = targetQueryId ? `refund:${targetQueryId}` : null;
      const targetHashHex = TonCenterClient.normalizeTxHashHex(payout.txHash);
      let pendingHit = null;
      let failedHit = null;
      for (const m of msgs) {
        const destKey = addressKey(m.destination || '');
        if (destKey !== targetRecipientKey) continue;
        const val = BigInt(m.value || 0);
        const comment = String(m.message_content?.decoded?.comment ?? m.comment ?? '').trim();
        const txHash = m.in_msg_tx_hash || m.out_msg_tx_hash || m.tx_hash || m.hash || null;
        const candidateHashes = [m.in_msg_tx_hash, m.out_msg_tx_hash, m.tx_hash, m.hash]
          .map((h) => TonCenterClient.normalizeTxHashHex(h))
          .filter(Boolean);
        const memoHit = Boolean(expectedMemo && comment === expectedMemo);
        const hashHit = Boolean(targetHashHex && candidateHashes.includes(targetHashHex));
        if (!memoHit && !hashHit) continue;
        if (m.bounced === true || m.aborted === true) {
          failedHit = { state: 'FAILED', txHash: txHash || payout.txHash || null, reason: 'REFUND_BOUNCED_OR_ABORTED' };
          continue;
        }
        if (m.trace_incomplete === true) {
          if (!pendingHit) pendingHit = { state: 'PENDING', txHash: txHash || payout.txHash || null, reason: 'TRACE_INCOMPLETE' };
          continue;
        }
        // direction=in 必须存在非空 in_msg_tx_hash 才证明已在目标账户真实落地执行
        if (!m.in_msg_tx_hash) {
          if (!pendingHit) pendingHit = { state: 'PENDING', txHash: txHash || payout.txHash || null, reason: 'IN_MSG_NOT_DELIVERED' };
          continue;
        }
        if (val >= targetAmount) {
          return { state: 'CONFIRMED', txHash: m.in_msg_tx_hash || txHash || payout.txHash || null };
        }
      }
      if (pendingHit) return pendingHit;
      if (failedHit) return failedHit;
      if (canDeclareNotFound && msgs.length < Number(limit || 50)) {
        return { state: 'NOT_FOUND', reason: 'ONCHAIN_REFUND_NOT_FOUND' };
      }
      return { state: 'PENDING' };
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
    const jwAddr = decodeAddressFromStackItem(s[0], { testnet: this.testnet });
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
    const ticketAddr = decodeAddressFromStackItem(s[0], { testnet: this.testnet });
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
   * 链上未配置或请求失败时严格返回 null 与不可用标记，绝不将查询失败显示为余额 0。
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
    if (roundControllerAddress && Array.isArray(roundIds) && roundIds.length) {
      const results = new Array(roundIds.length).fill(null);
      const concurrency = Math.min(4, roundIds.length);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (cursor < roundIds.length) {
            const idx = cursor;
            cursor += 1;
            const rId = roundIds[idx];
            try {
              const t = await this.fetchUserTicket(roundControllerAddress, ownerAddress, rId);
              if (t && BigInt(t.amountRaw) > 0n) results[idx] = t;
            } catch {
              ticketsAvailable = false;
            }
          }
        }),
      );
      for (const item of results) {
        if (item) tickets.push(item);
      }
    }
    const onchainAvailable = Boolean(
      (jettonMasterAddress || roundControllerAddress) &&
      (!jettonMasterAddress || balanceAvailable) &&
      (!roundControllerAddress || ticketsAvailable),
    );
    return {
      jettonWallet,
      a9BalanceRaw,
      balanceAvailable,
      tickets,
      ticketsAvailable,
      onchainAvailable,
    };
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

function decodeAddressFromStackItem(item, opts = {}) {
  if (!Array.isArray(item)) return null;
  if ((item[0] === 'cell' || item[0] === 'slice') && item[1]?.bytes) {
    return decodeAddressFromCellBoc(item[1].bytes, opts);
  }
  return null;
}
