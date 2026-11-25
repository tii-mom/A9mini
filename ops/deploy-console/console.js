import { parseTonAddress } from '/vendor/v15-tx.js';

let bundle = null;
let liveStatus = null;
let tcUi = null;
let connectedWallet = null;
let busyStep = null;

const logEl = document.getElementById('log-box');
const walletPanel = document.getElementById('wallet-panel');
const contractsPanel = document.getElementById('contracts-panel');
const stepsContainer = document.getElementById('steps-container');
const overallChip = document.getElementById('overall-chip');
const btnConnect = document.getElementById('btn-connect');
const btnRefresh = document.getElementById('btn-refresh');

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logEl.textContent = `[${ts}] ${msg}\n` + logEl.textContent;
}

function canonKey(addr) {
  try {
    const p = parseTonAddress(String(addr || '').trim());
    return `${p.workchain}:${Array.from(p.hash, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return '';
  }
}

function fmtA9(rawStr) {
  try {
    const whole = BigInt(rawStr || '0') / 1_000_000_000n;
    return `${whole.toLocaleString('en-US')} A9`;
  } catch {
    return '0 A9';
  }
}

function short(a) {
  const s = String(a || '');
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s;
}

function render() {
  if (!bundle) return;
  const wAddr = connectedWallet?.account?.address || '';
  const wChain = String(connectedWallet?.account?.chain || '');
  const wKey = canonKey(wAddr);
  const depKey = canonKey(bundle.roles.deployer);
  const treKey = canonKey(bundle.roles.treasury);

  let connectedRole = '未匹配角色';
  if (wKey && wKey === depKey) connectedRole = 'deployer（部署钱包）';
  else if (wKey && wKey === treKey) connectedRole = 'treasury（金库钱包）';

  btnConnect.textContent = wAddr ? `已连 ${short(wAddr)}（点击切换/断开）` : '连接手机 W5 钱包';

  const depBal = liveStatus?.wallets?.deployer?.balanceGram ?? '—';
  const treBal = liveStatus?.wallets?.treasury?.balanceGram ?? '—';

  walletPanel.innerHTML = `
    <div class="box">
      <small>当前已连接钱包 / 网络</small>
      <strong class="mono">${wAddr ? `${short(wAddr)} · ${wChain === '-239' ? 'MAINNET (-239)' : `错链 (${wChain})`}` : '尚未连接'}</strong>
      <p style="margin-top:4px;">识别角色：<b>${wAddr ? connectedRole : '请扫码连接部署钱包或金库钱包'}</b></p>
    </div>
    <div class="box">
      <small>主网钱包实时 GRAM 余额（建议：部署 1.10 / 金库 0.70）</small>
      <strong class="mono">部署钱包 (${short(bundle.roles.deployer)}): ${depBal} GRAM</strong>
      <strong class="mono">金库钱包 (${short(bundle.roles.treasury)}): ${treBal} GRAM</strong>
    </div>
  `;

  const c = bundle.contracts;
  const sc = liveStatus?.contracts;
  overallChip.className = liveStatus?.allDone ? 'chip green' : 'chip gold';
  overallChip.textContent = liveStatus?.allDone ? '全部 5 步已在主网完成并验真' : '等待按顺序签名确认';

  contractsPanel.innerHTML = `
    <div class="box">
      <small>JettonMaster（总供应 100 亿 · 元数据 app.a9.lat/a9.json）</small>
      <strong class="mono">${c.jettonMaster}</strong>
      <p>状态：<b>${sc?.jettonMaster?.state || '—'}</b> · 已铸：<b>${fmtA9(sc?.jettonMaster?.totalSupplyRaw)}</b> · 弃权：<b>${sc?.jettonMaster?.adminRenounced ? '已永久弃权' : '否'}</b></p>
    </div>
    <div class="box">
      <small>RoundController v17.0（涨价解锁 · 头矿 6H 5% 止损 · 14 天逐秒解锁）</small>
      <strong class="mono">${c.roundController}</strong>
      <p>状态：<b>${sc?.roundController?.state || '—'}</b> · 奖池已注资：<b>${fmtA9(sc?.rcJettonWallet?.a9Raw)}</b></p>
    </div>
    <div class="box">
      <small>金库 A9 钱包 (Treasury JettonWallet)</small>
      <strong class="mono">${c.treasuryJettonWallet}</strong>
      <p>当前实持 A9：<b>${fmtA9(sc?.treasuryJettonWallet?.a9Raw)}</b></p>
    </div>
    <div class="box">
      <small>主控合约 A9 钱包 (RC JettonWallet)</small>
      <strong class="mono">${c.rcJettonWallet}</strong>
      <p>当前实持 A9：<b>${fmtA9(sc?.rcJettonWallet?.a9Raw)}</b></p>
    </div>
  `;

  stepsContainer.innerHTML = bundle.steps.map((st) => {
    const stState = liveStatus?.steps?.[st.step] || { done: false, unlocked: false };
    const needKey = canonKey(st.signerAddress);
    const walletMatch = Boolean(wKey && wKey === needKey && wChain === '-239');
    const canSend = !stState.done && stState.unlocked && walletMatch && busyStep === null;

    let badge = '<span class="chip">等待前置步骤完成</span>';
    if (stState.done) badge = '<span class="chip green">主网已确认完成</span>';
    else if (stState.unlocked) badge = '<span class="chip red">待签名执行</span>';

    let btnText = `发起第 ${st.step} 步签名（附 ${st.amountGram} GRAM）`;
    if (stState.done) btnText = '已完成（不可重复发送）';
    else if (!stState.unlocked) btnText = '前置步骤链上确认后自动解锁';
    else if (!wAddr) btnText = `请先连接 ${st.signerRole === 'deployer' ? '部署钱包' : '金库钱包'}`;
    else if (wChain !== '-239') btnText = '钱包非主网 (-239)，已拦截';
    else if (!walletMatch) btnText = `请切换钱包至 ${st.signerRole === 'deployer' ? '部署钱包' : '金库钱包'} (${short(st.signerAddress)})`;
    else if (busyStep === st.step) btnText = '请在手机钱包点确认…';

    return `
      <article class="card step-card ${stState.done ? 'done' : stState.unlocked ? 'active' : ''}">
        <div class="row">
          <h2>${st.title}</h2>
          ${badge}
        </div>
        <p>${st.description}</p>
        <p class="mono" style="font-size:12px;">
          要求签名钱包：<b>${st.signerRole}</b> (${st.signerAddress}) · 附带金额：<b>${st.amountGram} GRAM</b>
        </p>
        <div style="margin-top:10px;">
          <button class="btn ${stState.done ? 'btn-green' : 'btn-red'}" data-send-step="${st.step}" type="button" ${canSend ? '' : 'disabled'}>
            ${btnText}
          </button>
        </div>
      </article>
    `;
  }).join('');

  stepsContainer.querySelectorAll('[data-send-step]').forEach((btn) => {
    btn.onclick = () => sendStep(Number(btn.dataset.sendStep));
  });
}

async function sendStep(stepNum) {
  const st = bundle.steps.find((s) => s.step === stepNum);
  if (!st || !tcUi) return;
  busyStep = stepNum;
  render();
  log(`发起第 ${stepNum} 步 (${st.id}) -> 目标 ${short(st.message.address)}，金额 ${st.amountGram} GRAM，请在手机钱包确认…`);
  try {
    const tx = {
      validUntil: Math.floor(Date.now() / 1000) + 300,
      network: '-239',
      from: connectedWallet.account.address,
      messages: [st.message],
    };
    await tcUi.sendTransaction(tx);
    log(`第 ${stepNum} 步已在钱包签名并广播！等待主网出块确认（每 5 秒自动核验）…`);
    setTimeout(() => refreshStatus(true), 6000);
    setTimeout(() => refreshStatus(true), 14000);
    setTimeout(() => refreshStatus(true), 24000);
  } catch (e) {
    log(`第 ${stepNum} 步取消或失败：${e?.message || e}`);
  } finally {
    busyStep = null;
    render();
  }
}

async function refreshStatus(force = false) {
  try {
    const res = await fetch(force ? '/api/status?force=1' : '/api/status');
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'status failed');
    liveStatus = j.data;
    render();
    log(`主网状态刷新完成：部署钱包 ${liveStatus.wallets.deployer.balanceGram} GRAM，金库钱包 ${liveStatus.wallets.treasury.balanceGram} GRAM。`);
  } catch (e) {
    log(`主网状态读取失败：${e?.message || e}`);
  }
}

async function boot() {
  bundle = await (await fetch('/api/bundle')).json();
  if (window.TON_CONNECT_UI?.TonConnectUI) {
    tcUi = new window.TON_CONNECT_UI.TonConnectUI({
      manifestUrl: 'https://app.a9.lat/tonconnect-manifest.json',
    });
    tcUi.onStatusChange((w) => {
      connectedWallet = w || null;
      if (w?.account?.address) log(`钱包已连接：${w.account.address} (chain=${w.account.chain})`);
      else log('钱包已断开连接');
      render();
    });
  } else {
    log('TON Connect UI SDK 加载失败，请刷新页面。');
  }
  btnConnect.onclick = async () => {
    if (!tcUi) return;
    if (connectedWallet) {
      await tcUi.disconnect();
      return;
    }
    await tcUi.openModal();
  };
  btnRefresh.onclick = () => refreshStatus(true);
  render();
  await refreshStatus(true);
  setInterval(() => refreshStatus(false), 12000);
}

window.addEventListener('DOMContentLoaded', boot);
