/**
 * Tab 4 · 战队（#/team）— A9 Quest 视图层
 *
 * - 复用 share.js（基于 protocolConfig.botHandle）生成邀请链接与 Telegram 原生分享；
 * - 保留队长绑定/核验 TG 群流程（bindTeamGroupTg / verifyTeamGroupTg）与 5,000 A9 创世金库状态；
 * - 对接 fetchMyChests（5 阶免费任务宝箱，受 chestMall.openEnabled 门控）、fetchPromoBalance、
 *   fetchMyStakeReferrals（好友通关 8% 返佣明细）、fetchRoundAirdropDraws（每关 100,000 A9 空投公示）；
 * - P2 诚实策略：后端公开 API 未下发推广熔断 6 桶实时消耗值，仅展示静态协议 6 桶硬顶配置表（总硬顶 550,000,000 A9），严禁伪造剩余进度条。
 */

import { store } from '../store.js';
import { config } from '../config.js';
import { A9Haptic } from '../tma.js';
import { escapeHtml, formatNum, copyText, showToast } from '../components.js';
import { L } from '../i18n.js';
import { buildTmaDeepLink, getShareRef, openXShareSheet } from '../share.js';
import {
  PROTOCOL_SPECS,
  rawToA9,
  fetchMyChests,
  fetchPromoBalance,
  fetchWalletTeam,
  fetchMyStakeReferrals,
  fetchRoundAirdropDraws,
  openChestById,
  bindTeamGroupTg,
  verifyTeamGroupTg,
} from '../data.js';
import {
  qIcon,
  chestArtSvg,
  finiteOrNull,
  fmtExactA9,
  fmtIntOrDash,
  openQuestSheet,
} from './quest-ui.js';
import { showFreeChestReward } from './chest-view.js';

let teamViewSeq = 0;

/** 协议静态 6 独立额度桶硬顶配置表（总硬顶 550,000,000 A9，不伪造实时已用值） */
const STATIC_PROMO_BUCKETS = Object.freeze([
  { zh: '商城直推返佣 / 加赠', en: 'Chest Mall Referral & Bonus', capA9: 48_000_000 },
  { zh: '免费任务宝箱', en: 'Free Task Chests', capA9: 100_000_000 },
  { zh: '12H 预言擂台', en: '12H Prediction Arena', capA9: 100_000_000 },
  { zh: '下轮预热宝箱', en: 'Warm-Up Chests', capA9: 52_000_000 },
  { zh: '好友通关返佣 8%', en: 'Friend Pass 8% Rebate', capA9: 200_000_000 },
  { zh: '每关等权空投（100,000 A9 / 关）', en: 'Per-Stage Equal Airdrop', capA9: 50_000_000 },
]);

/** 渲染 Tab 4 · 战队主视图 */
export function renderTeamView(root, _navigate, _param = null, _query = {}) {
  const seq = ++teamViewSeq;
  const isLive = !config.isDemo;

  const state = {
    chestsData: null,
    promo: null,
    stakeRefs: null,
    airdrops: [],
    loading: isLive,
    team: null,
    teamError: false,
  };

  const openBindTgSheet = () => {
    openQuestSheet(
      L('队长绑定 / 核验 Telegram 群', 'Captain TG Group Bind & Verify'),
      `
        <div class="q-notice blue" style="margin-bottom:10px;">
          ${qIcon('shield', 16)}
          <span>${L('提交群用户名进入待核验状态后，请将官方 Bot 拉入群并设为管理员，再点击「发起群核验」。', 'Submit your group handle, add the official Bot as admin, then tap Verify Group.')}</span>
        </div>
        <div class="q-amt-box" style="margin-bottom:10px;">
          <input id="q-tg-handle-input" type="text" placeholder="@YourSquadGroup" style="font-size:16px;font-weight:700;" />
        </div>
        <div class="q-btn-row">
          <button class="q-btn q-btn-ghost q-grow q-btn-sm" id="q-tg-submit-bind" type="button">${L('提交群名', 'Submit Handle')}</button>
          <button class="q-btn q-btn-blue q-grow q-btn-sm" id="q-tg-verify-now" type="button">${L('发起群核验', 'Verify Group')}</button>
        </div>
      `
    );

    const teamId = isLive ? state.team?.teamId : store.state.team?.id;
    const bindBtn = document.getElementById('q-tg-submit-bind');
    const verifyBtn = document.getElementById('q-tg-verify-now');
    const inp = document.getElementById('q-tg-handle-input');

    if (bindBtn) {
      bindBtn.onclick = async () => {
        const handle = String(inp?.value || '').trim();
        if (!handle) {
          showToast(L('请输入有效的 Telegram 群用户名', 'Enter a valid Telegram group handle'), 'amber');
          return;
        }
        try {
          await bindTeamGroupTg({ teamId, tgGroupHandle: handle });
          showToast(L('已提交待核验，请完成 Bot 入群授权后点击核验', 'Submitted for verification'));
        } catch (e) {
          showToast(e?.message || L('提交群绑定失败', 'Bind request failed'), 'error');
        }
      };
    }

    if (verifyBtn) {
      verifyBtn.onclick = async () => {
        try {
          await verifyTeamGroupTg({ teamId });
          A9Haptic.success();
          showToast(L('Telegram 群核验已通过！', 'Telegram group verified!'));
          void loadAll();
        } catch (e) {
          showToast(e?.message || L('群核验未通过，请确认 Bot 已入群且为管理员', 'Verification failed; ensure Bot is group admin'), 'error');
        }
      };
    }
  };

  const paint = () => {
    if (seq !== teamViewSeq || !root.isConnected) return;
    const t = (isLive ? state.team : store.state.team) || {};
    const groupBound = isLive ? t.bindStatus === 'bound' : t.tgGroupBound;
    const teamName = t.name || (isLive
      ? (state.teamError || state.loading ? L('战队信息待同步', 'Squad pending') : L('暂无已绑定战队', 'No linked squad'))
      : L('A9 冲关小队', 'A9 Quest Squad'));
    const refCode = getShareRef();
    const inviteLink = buildTmaDeepLink(refCode ? `invite_${refCode}` : 'invite');
    const promoA9 = state.promo
      ? rawToA9(state.promo.claimableRaw ?? state.promo.availableRaw)
      : (!isLive ? finiteOrNull(store.state.user.promoClaimableA9) : null);

    const refTotalA9 = rawToA9(state.stakeRefs?.totalCommissionRaw);
    const refCount = finiteOrNull(state.stakeRefs?.count);

    const chestsData = state.chestsData || {};
    const freeChests = Array.isArray(chestsData.freeChests) ? chestsData.freeChests : [];
    const freeTiersCfg = Array.isArray(store.state.round?.chestMall?.freeTiers)
      ? store.state.round.chestMall.freeTiers
      : [];
    const openEnabled = config.isDemo || Boolean(store.state.round?.chestMall?.openEnabled === true && store.fundsEnabled);
    const captainPaid = Boolean(isLive ? t.captainVaultPaid : chestsData.captainVaultPaid || chestsData.foundingBonusPaid);
    const displayTiers = freeChests.length > 0 ? freeChests : freeTiersCfg;

    root.innerHTML = `
      <div class="q-view" id="quest-team-view">
        <section class="q-hero q-hero--blue">
          <span class="q-wm" style="font-size:96px;">${qIcon('team', 108, 1.3)}</span>
          <div class="q-hero-top">
            <span class="q-cart-tag">SQUAD</span>
            <span class="q-phase-pill">${captainPaid ? L('队长创世金库 5,000 A9 已发', '5,000 A9 Founding Vault Paid') : L('邀请裂变战队', 'Referral Squad')}</span>
          </div>
          <div class="q-hero-label">${L('我的战队', 'My Squad')}</div>
          <div class="q-hero-count" style="font-size:28px;">${escapeHtml(teamName)}</div>
          <div class="q-rebates">
            <span>${L(`好友购箱 返 ${PROTOCOL_SPECS.referralPct}%`, `Chest Mall ${PROTOCOL_SPECS.referralPct}%`)}</span>
            <span>${L(`好友通关奖金 返 ${PROTOCOL_SPECS.stakeReferralPct}%`, `Friend Pass ${PROTOCOL_SPECS.stakeReferralPct}%`)}</span>
            <span>${L('1 次购箱 = 3 次助力', '1 Purchase = 3 Assists')}</span>
          </div>
          <div class="q-invite">
            <code id="q-invite-url">${escapeHtml(inviteLink)}</code>
            <button class="icon-btn" id="q-copy-invite" type="button" aria-label="${L('复制邀请链接', 'Copy invite link')}">${qIcon('copy', 15)}</button>
            <button class="icon-btn" id="q-share-invite" type="button" aria-label="${L('分享到 Telegram', 'Share on Telegram')}">${qIcon('share', 15)}</button>
          </div>
        </section>

        <section class="q-card" id="team-commission-summary">
          <div class="q-card-h">
            <h3>${qIcon('gift', 18)} ${L('返佣收益与领取', 'Referral Earnings')}</h3>
            <a class="q-chip q-chip-green" href="#/rewards" style="text-decoration:none;">${L('去金库领取', 'Claim in Vault')} ›</a>
          </div>
          <div class="q-grid2">
            <div class="q-stat">
              <small>${L('站内可领推广余额', 'Claimable Promo Balance')}</small>
              <b class="q-num">${escapeHtml(fmtExactA9(promoA9))}</b>
              <span>${L('以推广账本为准', 'From promo ledger')}</span>
            </div>
            <div class="q-stat">
              <small>${L('好友通关 8% 返佣', '8% Pass Credits')}</small>
              <b class="q-num">${escapeHtml(fmtExactA9(refTotalA9))}</b>
              <span>${refCount ?? '—'} ${L('笔记录', 'records')}</span>
            </div>
          </div>
        </section>

        <section class="q-card" id="q-free-ladder-card">
          <div class="q-card-h">
            <h3>${qIcon('chest', 18)} ${L('战队任务宝箱（5 阶）', 'Squad Task Chests (5 Tiers)')}</h3>
            <span class="q-chip">${openEnabled ? L('已开放开启', 'Open') : L('待开启', 'Gated')}</span>
          </div>
          ${displayTiers.length === 0 ? `
            <div class="q-small q-muted">${state.loading ? L('正在同步 5 阶任务宝箱进度…', 'Syncing 5-tier task chests…') : L('请在 Telegram 小程序内打开以查看你的 5 阶免费任务宝箱进度。', 'Open inside Telegram Mini App to track your 5-tier free task chests.')}</div>
          ` : `
            <div class="q-ladder">
              ${displayTiers.map((ch) => {
                const tier = String(ch.tier || 'bronze').toLowerCase();
                const status = String(ch.status || 'LOCKED').toUpperCase();
                const isDone = status === 'OPENED' || status === 'CLAIMED';
                const isReady = status === 'READY' || ch.canOpen === true;
                const rewardA9 = rawToA9(ch.baseA9Raw) ?? finiteOrNull(ch.rewardA9);
                const curA = finiteOrNull(ch.currentAssists);
                const reqA = finiteOrNull(ch.requiredAssists);
                return `
                  <div class="q-rung ${isDone ? 'done' : isReady ? 'ready' : ''}">
                    ${chestArtSvg(tier, 46)}
                    <div style="min-width:0;">
                      <b>${escapeHtml(L(ch.labelZh || ch.name || tier, ch.labelEn || ch.name || tier))}</b>
                      <span class="q-rw">${fmtIntOrDash(rewardA9)} A9</span>
                      ${reqA !== null && reqA > 0 ? `
                        <div class="q-req">
                          <span>${L('助力', 'Assists')}</span>
                          <span class="q-mini"><i class="${(curA ?? 0) >= reqA ? 'ok' : ''}" style="width:${Math.min(100, Math.round(((curA ?? 0) / reqA) * 100))}%"></i></span>
                          <em>${curA ?? 0}/${reqA}</em>
                        </div>
                      ` : `<div class="q-small q-muted">${L('免助力 · 达标即开', 'Zero assists required')}</div>`}
                    </div>
                    ${isDone
                      ? `<span class="q-chip q-chip-green">${L('已领', 'Claimed')}</span>`
                      : isReady
                        ? `<button type="button" class="q-btn q-btn-red q-btn-sm" data-q-open-free="${escapeHtml(ch.chestId || ch.id || '')}" ${openEnabled ? '' : 'disabled'}>${L('开启', 'Open')}</button>`
                        : `<span class="q-chip">${L('进行中', 'In Progress')}</span>`}
                  </div>
                `;
              }).join('')}
            </div>
          `}
        </section>

        <section class="q-card" id="q-captain-tg-card">
          <div class="q-card-h">
            <h3>${qIcon('team', 18)} ${L('队长 Telegram 群认证', 'Captain TG Group Verification')}</h3>
            <span class="q-chip ${groupBound ? 'q-chip-green' : ''}">${groupBound ? L('已核验绑定', 'Verified') : isLive && !t.bindStatus ? '—' : t.bindStatus === 'verifying' ? L('核验中', 'Verifying') : L('待绑定', 'Unbound')}</span>
          </div>
          <div class="q-small q-muted" style="line-height:1.5;margin-bottom:10px;">
            ${L('队长绑定并核验至少 50 人的群，且战队满 3 人，可获得 5,000 A9 创世金库资格。', 'Captains qualify for the 5,000 A9 founding vault with a verified group of 50+ and at least 3 squad members.')}
          </div>
          <div class="q-btn-row">
            <button class="q-btn q-btn-blue q-btn-sm q-grow" id="q-open-bind-tg" type="button">${L('绑定 / 核验 TG 群', 'Bind / Verify TG Group')}</button>
            <a class="q-btn q-btn-ghost q-btn-sm" href="#/team/invite">${L('海报邀请', 'Poster')}</a>
          </div>
        </section>

        <section class="q-card" id="q-airdrop-draws-card">
          <div class="q-card-h">
            <h3>${qIcon('dice', 18)} ${L('每关等权空投 · 100,000 A9', 'Per-Stage Equal Airdrop · 100,000 A9')}</h3>
            <span class="q-chip q-chip-blue">${L('锁仓 ≥ 100 A9 入池', 'Lock ≥ 100 A9')}</span>
          </div>
          <div class="q-small q-muted" style="line-height:1.5;margin-bottom:8px;">
            ${L('每关结算后以链上确定性种子公开抽奖，人人机会均等、与锁仓金额无关。', 'Deterministic public draw after each stage settlement; equal odds regardless of lock size.')}
          </div>
          ${state.airdrops.length === 0 ? `
            <div class="q-small q-muted">${L('暂无已开奖空投公示记录。', 'No settled airdrop draws yet.')}</div>
          ` : `
            <div class="q-feed">
              ${state.airdrops.slice(0, 5).map((d) => `
                <div class="q-feed-i">
                  <span class="q-chip q-chip-blue">R${escapeHtml(String(d.roundId ?? '—'))}</span>
                  <div>
                    <span class="q-who">${escapeHtml(d.winnerWallet || L('已公示', 'Published'))}</span>
                    <small>${L('种子哈希可复验', 'Verifiable SHA-256 seed')}</small>
                  </div>
                  <span class="q-amt q-num">${fmtExactA9(rawToA9(d.prizeRaw))}</span>
                </div>
              `).join('')}
            </div>
          `}
        </section>

        <section class="q-card" id="q-promo-cap-card">
          <div class="q-card-h">
            <h3>${qIcon('shield', 18)} ${L('推广熔断硬顶规则', 'Promo Hard-Cap Rules')}</h3>
            <span class="q-chip">${L('6 独立额度桶', '6 Independent Buckets')}</span>
          </div>
          <div class="q-small q-muted" style="margin-bottom:8px;line-height:1.5;">
            ${L(
              `推广总硬顶 ${formatNum(PROTOCOL_SPECS.promoCapA9, 0)} A9 · 6 独立额度桶熔断保护，用完即停、绝不超发。`,
              `Total Promo Hard Cap: ${formatNum(PROTOCOL_SPECS.promoCapA9, 0)} A9 across 6 independent circuit-breaker buckets.`
            )}
          </div>
          ${STATIC_PROMO_BUCKETS.map((b) => `
            <div class="q-kv">
              <span>${escapeHtml(L(b.zh, b.en))}</span>
              <b class="q-num">${formatNum(b.capA9, 0)} A9</b>
            </div>
          `).join('')}
        </section>
      </div>
    `;

    const copyBtn = root.querySelector('#q-copy-invite');
    if (copyBtn) copyBtn.onclick = () => copyText(inviteLink, L('邀请链接已复制', 'Invite link copied'));

    const shareBtn = root.querySelector('#q-share-invite');
    if (shareBtn) {
      shareBtn.onclick = () => openXShareSheet({
        type: 'invite',
        id: refCode || 'squad',
        context: { inviteLink },
      });
    }

    const bindTgBtn = root.querySelector('#q-open-bind-tg');
    if (bindTgBtn) bindTgBtn.onclick = () => {
      if (isLive && (!state.team?.teamId || state.team.role !== 'captain')) _navigate('/team/bind-tg');
      else openBindTgSheet();
    };

    root.querySelectorAll('[data-q-open-free]').forEach((btn) => {
      btn.onclick = async () => {
        const cid = btn.dataset.qOpenFree;
        if (!cid) return;
        try {
          const res = await openChestById(cid, store.state, store.state.user.address);
          showFreeChestReward(res);
          void loadAll();
        } catch (e) {
          showToast(e?.message || L('开启任务宝箱失败', 'Failed to open task chest'), 'error');
        }
      };
    });
  };

  const loadAll = async () => {
    const addr = store.state.user.connected ? store.state.user.address : null;
    const [chRes, prRes, srRes, adRes, teamRes] = await Promise.allSettled([
      fetchMyChests(),
      (isLive && addr) ? fetchPromoBalance(addr) : Promise.resolve(null),
      fetchMyStakeReferrals(30),
      fetchRoundAirdropDraws({ limit: 8 }),
      (isLive && addr) ? fetchWalletTeam(addr) : Promise.resolve(null),
    ]);
    if (seq !== teamViewSeq || !root.isConnected) return;
    if (isLive && addr !== (store.state.user.connected ? store.state.user.address : null)) return;
    state.team = teamRes.status === 'fulfilled' ? teamRes.value : null;
    state.teamError = teamRes.status === 'rejected';
    if (chRes.status === 'fulfilled' && chRes.value) state.chestsData = chRes.value;
    if (prRes.status === 'fulfilled' && prRes.value) state.promo = prRes.value;
    if (srRes.status === 'fulfilled' && srRes.value) state.stakeRefs = srRes.value;
    if (adRes.status === 'fulfilled' && adRes.value) {
      state.airdrops = Array.isArray(adRes.value?.items) ? adRes.value.items : (Array.isArray(adRes.value) ? adRes.value : []);
    }
    state.loading = false;
    paint();
  };

  paint();
  void loadAll();
}
