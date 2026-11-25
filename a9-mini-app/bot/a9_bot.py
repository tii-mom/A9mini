#!/usr/bin/env python3
"""
A9 · 财富大冒险 Telegram Bot 配套服务（命令菜单 + 安全 Mini App 深链）。

数据真实性约束（P0-3）：
- 严禁打印任何硬编码轮次、价格、锁仓或收益数字；
- 实时数据经异步线程从 Worker API（A9_API_BASE）拉取，不可达或缺失时一律显示“待核验”；
- 个人余额与可领取数额仅在小程序内完成 Telegram initData + ton_proof 验签后展示。

用法：
  export A9_BOT_TOKEN="your_botfather_token"
  export A9_MINI_APP_URL="https://app.a9.lat/?mode=live"
  export A9_API_BASE="https://api.a9.lat"
  pip install "python-telegram-bot>=21.0"
  python3 bot/a9_bot.py
"""

import asyncio
import html
import json
import logging
import os
import re
import urllib.parse
import urllib.request

logging.basicConfig(level=logging.INFO, format="[a9-bot] %(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("a9_bot")

BOT_TOKEN = os.getenv("A9_BOT_TOKEN", "")
MINI_APP_URL = os.getenv("A9_MINI_APP_URL", "https://app.a9.lat/?mode=live").strip()
API_BASE = os.getenv("A9_API_BASE", "").rstrip("/")

PENDING = "待核验"
SAFE_STARTAPP_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ACTIVE_STATES = {
    "STAKING_OPEN",
    "STAKING_CLOSED",
    "OBSERVING",
    "ORACLE_PAUSED",
    "SETTLING_SUCCESS",
    "SETTLING_FAILURE",
}
STATE_LABELS = {
    "STAKING_OPEN": "24H 锁仓开放中",
    "STAKING_CLOSED": "锁仓已封盘",
    "OBSERVING": "12H 冲价中",
    "ORACLE_PAUSED": "预言机保护暂停",
    "SETTLING_SUCCESS": "通关结算中",
    "SETTLING_FAILURE": "未通关 · 自动止损结算中",
    "SUCCEEDED": "已通关",
    "FAILED": "未通关 · 自动止损",
    "FAILED_PERMANENT": "未通关 · 自动止损",
    "TECHNICAL_ABORTED": "异常中止 · 退回本金",
    "UNOPENED": "未开启",
}
ROUTE_MAP = {
    "market": "market",
    "claim": "claim",
    "position": "profile",
    "team": "team",
    "rank": "leaderboard",
    "help": "rules",
}


def build_mini_app_url(startapp=None):
    """安全拼接 Mini App URL，保留现有查询参数并默认注入 mode=live，避免出现双问号破坏链接。"""
    parsed = urllib.parse.urlsplit(MINI_APP_URL or "https://app.a9.lat/?mode=live")
    params = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=False))
    params.setdefault("mode", "live")
    if startapp:
        clean = str(startapp).strip()
        if SAFE_STARTAPP_RE.match(clean):
            params["startapp"] = clean
    query = urllib.parse.urlencode(params)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path or "/", query, parsed.fragment))


def _fetch_json_sync(path, timeout=4):
    """同步请求 Worker API（供 asyncio.to_thread 调用，绝不阻塞事件循环）。"""
    if not API_BASE:
        return None
    try:
        req = urllib.request.Request(f"{API_BASE}{path}", headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = json.loads(res.read().decode("utf-8"))
        return body.get("data") if isinstance(body, dict) and body.get("ok") else None
    except Exception:
        return None


async def fetch_json(path, timeout=4):
    return await asyncio.to_thread(_fetch_json_sync, path, timeout)


def usd_e8(raw):
    try:
        v = int(str(raw))
    except (TypeError, ValueError):
        return PENDING
    return f"${v / 1e8:.4f}" if v > 0 else PENDING


ASCII_DIGITS_RE = re.compile(r"^[0-9]+$")


def pick_focus_round(rounds):
    """与前端 data.js 保持一致：先校验 state 为字符串，再优先进行中最高轮 -> 最近已开启轮 -> 首轮。"""
    if not isinstance(rounds, list) or not rounds:
        return None
    valid_dicts = [r for r in rounds if isinstance(r, dict) and isinstance(r.get("state"), str)]
    opened = [r for r in valid_dicts if r.get("state") != "UNOPENED"]
    active = [r for r in opened if r.get("state") in ACTIVE_STATES]
    if active:
        return active[-1]
    if opened:
        return opened[-1]
    return valid_dicts[0] if valid_dicts else None


def _parse_positive_round_id(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, str):
        trimmed = value.strip()
        if not ASCII_DIGITS_RE.match(trimmed):
            return None
        try:
            parsed = int(trimmed, 10)
        except ValueError:
            return None
        return parsed if parsed > 0 else None
    return None


async def current_round_summary():
    """从实时协议接口读取焦点轮摘要，显式区分未开轮（unopened）、接口故障/数据异常（unavailable）与已开轮（active）。"""
    unavailable = {
        "status": "unavailable",
        "round": PENDING,
        "state": PENDING,
        "target": PENDING,
        "twap": PENDING,
        "qualified": PENDING,
    }
    rounds = await fetch_json("/api/rounds")
    if rounds is None or not isinstance(rounds, list):
        return unavailable
    if not rounds:
        return {
            "status": "unopened",
            "round": PENDING,
            "state": STATE_LABELS["UNOPENED"],
            "target": PENDING,
            "twap": PENDING,
            "qualified": PENDING,
        }
    r = pick_focus_round(rounds)
    if not isinstance(r, dict):
        return unavailable
    raw_state = r.get("state")
    if raw_state == "UNOPENED":
        return {
            "status": "unopened",
            "round": PENDING,
            "state": STATE_LABELS["UNOPENED"],
            "target": PENDING,
            "twap": PENDING,
            "qualified": PENDING,
        }
    round_id = _parse_positive_round_id(r.get("roundId"))
    if round_id is None or not isinstance(raw_state, str) or not raw_state.strip():
        return unavailable
    q = r.get("qualifiedCandles")
    raw_twap = r.get("priceUsdE8") if r.get("priceValid") is not False else None
    if raw_twap is None:
        raw_twap = r.get("twap24hUsdE8")
    return {
        "status": "active",
        "round": f"#{round_id}",
        "state": STATE_LABELS.get(raw_state, raw_state),
        "target": usd_e8(r.get("targetPriceUsdE8")),
        "twap": usd_e8(raw_twap),
        "qualified": f"{q}/12" if isinstance(q, int) and not isinstance(q, bool) else PENDING,
    }


def _esc(value):
    return html.escape(str(value or ""))


async def render_start():
    s = await current_round_summary()
    if s["status"] == "unopened":
        return (
            "<b>A9 · 财富大冒险</b>\n"
            "首轮涨价解锁蓄水筹备中，免费青铜宝箱与宝箱商城入口已就绪。\n\n"
            "• 免费宝箱：0 成本秒开 200 A9 青铜新手箱，进阶 5 阶梯队最高可领 200,000 A9（好友购箱 1 抵 3 助力加速）\n"
            "• 宝箱商城：0.99–500 GRAM 共 6 档纯区间随机开箱，保底 + 随机加赠合并直发钱包（最高 1,300,000 A9）\n"
            "• 战队与返佣：好友锁仓通关享 8% 返佣 · 每轮空投，商城直推 6% 返佣，绑定 ≥50 人真实 TG 群且满 3 名已绑定成员享 5,000 A9 创世金库\n\n"
            "点击下方按钮打开小程序。参与有风险，一切规则与结果以链上及协议公示为准。"
        )
    if s["status"] == "unavailable":
        return (
            "<b>A9 · 财富大冒险</b>\n"
            "协议状态接口暂不可达或返回数据异常，当前轮次与行情数据待核验，请稍后重试或在小程序内刷新查看。\n\n"
            "你仍可直接打开小程序查看规则、免费宝箱与宝箱商城入口。参与有风险，结果以链上结算为准。"
        )
    return (
        "<b>A9 · 财富大冒险</b>\n"
        "基于 TON 区块链智能合约（v17.0 涨价解锁）。以下数据来自协议接口，缺失时显示“待核验”。\n\n"
        f"• 当前轮次：<code>{_esc(s['round'])}</code>（{_esc(s['state'])}）\n"
        f"• 目标价：<code>{_esc(s['target'])}</code>\n"
        f"• 1H 均价：<code>{_esc(s['twap'])}</code>\n\n"
        "进入小程序查看实时详情。参与有风险，结果以链上结算为准。"
    )


async def render_round():
    s = await current_round_summary()
    if s["status"] == "unavailable":
        return (
            f"<b>轮次 {_esc(s['round'])} 实时状态</b>\n"
            f"• 阶段：{_esc(s['state'])}\n"
            f"• 目标价：<code>{_esc(s['target'])}</code>\n"
            f"• 达标时段：<code>{_esc(s['qualified'])}</code>（需 ≥ 8/12）\n"
            "协议状态接口暂不可达或返回数据异常，当前数据待核验，请稍后重试。"
        )
    return (
        f"<b>轮次 {_esc(s['round'])} 实时状态</b>\n"
        f"• 阶段：{_esc(s['state'])}\n"
        f"• 目标价：<code>{_esc(s['target'])}</code>\n"
        f"• 达标时段：<code>{_esc(s['qualified'])}</code>（需 ≥ 8/12）\n"
        "数据来自协议接口；缺失项显示“待核验”。"
    )


CLAIM_TEXT = (
    "<b>金库领奖入口</b>\n"
    "你的可领取数额仅在小程序内完成 Telegram 身份与钱包归属验签后显示。\n"
    "机器人消息不会展示任何个人收益数字。"
)


def build_bot():
    from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, MenuButtonWebApp, Update, WebAppInfo
    from telegram.ext import Application, CommandHandler, ContextTypes

    async def post_init(app: Application):
        await app.bot.set_my_commands([
            BotCommand("start", "打开 A9 · 财富大冒险"),
            BotCommand("round", "查看当前轮次状态"),
            BotCommand("claim", "打开金库领奖页"),
            BotCommand("position", "查看我的资产与凭证"),
            BotCommand("team", "查看我的战队"),
            BotCommand("rank", "查看财富榜"),
            BotCommand("help", "查看闯关指南"),
        ])
        await app.bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(text="A9 · 财富大冒险", web_app=WebAppInfo(url=build_mini_app_url()))
        )

    async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE):
        logger.warning("bot handler error: %s", context.error)

    async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
        msg = update.effective_message
        if msg is None:
            return
        # 保留 /start <payload> 归因参数（如 invite_* / chest_* / round_*），防止邀请归因丢失
        start_payload = context.args[0].strip() if context.args else None
        primary_url = build_mini_app_url(start_payload)
        kb = InlineKeyboardMarkup([
            [InlineKeyboardButton("打开 A9 · 财富大冒险", web_app=WebAppInfo(url=primary_url))],
            [InlineKeyboardButton("免费领青铜宝箱 / 宝箱商城", web_app=WebAppInfo(url=build_mini_app_url("market")))],
            [InlineKeyboardButton("查看我的领取状态", web_app=WebAppInfo(url=build_mini_app_url("claim")))],
        ])
        await msg.reply_text(await render_start(), parse_mode="HTML", reply_markup=kb)

    async def cmd_round(update: Update, context: ContextTypes.DEFAULT_TYPE):
        msg = update.effective_message
        if msg is None:
            return
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("查看实时轮次", web_app=WebAppInfo(url=build_mini_app_url()))]])
        await msg.reply_text(await render_round(), parse_mode="HTML", reply_markup=kb)

    async def cmd_claim(update: Update, context: ContextTypes.DEFAULT_TYPE):
        msg = update.effective_message
        if msg is None:
            return
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("打开领取页", web_app=WebAppInfo(url=build_mini_app_url("claim")))]])
        await msg.reply_text(CLAIM_TEXT, parse_mode="HTML", reply_markup=kb)

    async def cmd_simple(update: Update, context: ContextTypes.DEFAULT_TYPE):
        msg = update.effective_message
        if msg is None:
            return
        raw_token = (msg.text or "").split()[0].lstrip("/")
        cmd = raw_token.split("@")[0].lower()
        param = ROUTE_MAP.get(cmd, "")
        url = build_mini_app_url(param or None)
        kb = InlineKeyboardMarkup([[InlineKeyboardButton(f"打开 A9 /{cmd}", web_app=WebAppInfo(url=url))]])
        await msg.reply_text(
            f"指令 <code>/{_esc(cmd)}</code>：请在小程序内查看你的实时数据。",
            parse_mode="HTML",
            reply_markup=kb,
        )

    app = Application.builder().token(BOT_TOKEN).post_init(post_init).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("round", cmd_round))
    app.add_handler(CommandHandler("claim", cmd_claim))
    for c in ("position", "team", "rank", "help"):
        app.add_handler(CommandHandler(c, cmd_simple))
    app.add_error_handler(on_error)
    return app


if __name__ == "__main__":
    if not BOT_TOKEN:
        print("Set A9_BOT_TOKEN and A9_MINI_APP_URL environment variables to launch the Telegram Bot.")
    else:
        build_bot().run_polling()
