#!/usr/bin/env python3
"""
A9 Telegram Bot companion (commands + Mini App deep links).

Data truthfulness (phase 1 / P0-3): this bot NEVER prints hard-coded round, price, stake or
reward figures. Live numbers are read from the A9 worker API (A9_API_BASE); when the API is not
configured or unreachable the message says "待核验" instead of inventing values. Personal
balances / claimable rewards are only shown inside the Mini App after server-side auth.

Usage:
  export A9_BOT_TOKEN="your_botfather_token"
  export A9_MINI_APP_URL="https://your-deployed-domain.com"
  export A9_API_BASE="https://api.your-domain.com"   # optional; without it figures show 待核验
  pip install python-telegram-bot>=21.0
  python3 bot/a9_bot.py

NOTE: only ONE process may receive updates for a bot token. Before Telegram Stars payments
(phase 5) are wired, decide whether this polling bot or the Worker webhook owns updates.
"""

import json
import os
import urllib.request

BOT_TOKEN = os.getenv("A9_BOT_TOKEN", "")
MINI_APP_URL = os.getenv("A9_MINI_APP_URL", "https://t.me/A9Terminal_bot/app")
API_BASE = os.getenv("A9_API_BASE", "").rstrip("/")

PENDING = "待核验"
STATE_LABELS = {
    "STAKING_OPEN": "参与开放中",
    "OBSERVING": "24H 观察中",
    "AWAITING_SETTLE": "等待结算",
    "SUCCEEDED": "已达标",
    "FAILED": "未达标",
    "UNOPENED": "未开启",
}


def fetch_json(path, timeout=4):
    """GET {API_BASE}{path} -> data dict, or None on any failure (never fabricate)."""
    if not API_BASE:
        return None
    try:
        with urllib.request.urlopen(f"{API_BASE}{path}", timeout=timeout) as res:
            body = json.loads(res.read().decode("utf-8"))
        return body.get("data") if body.get("ok") else None
    except Exception:
        return None


def usd_e8(raw):
    try:
        v = int(str(raw))
    except (TypeError, ValueError):
        return PENDING
    return f"${v / 1e8:.4f}" if v > 0 else PENDING


def current_round_summary():
    """Return display fields for the focus round from the live API, or 待核验 placeholders."""
    rounds = fetch_json("/api/rounds")
    if not isinstance(rounds, list) or not rounds:
        return {"round": PENDING, "state": PENDING, "target": PENDING, "twap": PENDING, "qualified": PENDING}
    r = rounds[-1]
    q = r.get("qualifiedCandles")
    return {
        "round": f"#{r.get('roundId')}" if r.get("roundId") else PENDING,
        "state": STATE_LABELS.get(r.get("state"), r.get("state") or PENDING),
        "target": usd_e8(r.get("targetPriceUsdE8")),
        "twap": usd_e8(r.get("twap24hUsdE8")),
        "qualified": f"{q}/24" if isinstance(q, int) else PENDING,
    }


def render_start():
    s = current_round_summary()
    return (
        "*A9 链上挑战协议*\n"
        "基于 TON 区块链智能合约。以下数据来自协议接口，缺失时显示“待核验”。\n\n"
        f"• 当前轮次：`{s['round']}`（{s['state']}）\n"
        f"• 目标价：`{s['target']}`\n"
        f"• 24H 判定均价：`{s['twap']}`\n\n"
        "进入小程序查看实时详情。参与有风险，结果以链上结算为准。"
    )


def render_round():
    s = current_round_summary()
    return (
        f"*轮次 {s['round']} 实时状态*\n"
        f"• 阶段：{s['state']}\n"
        f"• 目标价：`{s['target']}`\n"
        f"• 达标时段：`{s['qualified']}`（需 ≥ 16/24）\n"
        "数据来自协议接口；缺失项显示“待核验”。"
    )


CLAIM_TEXT = (
    "*领取入口*\n"
    "你的可领取数额只在小程序内、完成 Telegram 身份与钱包验证后显示。\n"
    "机器人消息不会展示任何个人收益数字。"
)


def build_bot():
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
    from telegram.ext import Application, CommandHandler, ContextTypes

    async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
        kb = InlineKeyboardMarkup([
            [InlineKeyboardButton("打开 A9 小程序", web_app=WebAppInfo(url=MINI_APP_URL))],
            [InlineKeyboardButton("查看我的领取状态", web_app=WebAppInfo(url=f"{MINI_APP_URL}?startapp=claim"))],
        ])
        await update.message.reply_text(render_start(), parse_mode="Markdown", reply_markup=kb)

    async def cmd_round(update: Update, context: ContextTypes.DEFAULT_TYPE):
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("查看实时轮次", web_app=WebAppInfo(url=MINI_APP_URL))]])
        await update.message.reply_text(render_round(), parse_mode="Markdown", reply_markup=kb)

    async def cmd_claim(update: Update, context: ContextTypes.DEFAULT_TYPE):
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("打开领取页", web_app=WebAppInfo(url=f"{MINI_APP_URL}?startapp=claim"))]])
        await update.message.reply_text(CLAIM_TEXT, parse_mode="Markdown", reply_markup=kb)

    async def cmd_simple(update: Update, context: ContextTypes.DEFAULT_TYPE):
        cmd = (update.message.text or "").split()[0].lstrip("/")
        route_map = {"rank": "warmup"}
        param = route_map.get(cmd, "")
        url = f"{MINI_APP_URL}?startapp={param}" if param else MINI_APP_URL
        kb = InlineKeyboardMarkup([[InlineKeyboardButton(f"打开 A9 /{cmd}", web_app=WebAppInfo(url=url))]])
        await update.message.reply_text(f"指令 `/{cmd}`：请在小程序内查看你的实时数据。", parse_mode="Markdown", reply_markup=kb)

    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("round", cmd_round))
    app.add_handler(CommandHandler("claim", cmd_claim))
    for c in ("position", "team", "rank", "help"):
        app.add_handler(CommandHandler(c, cmd_simple))
    return app


if __name__ == "__main__":
    if not BOT_TOKEN:
        print("Set A9_BOT_TOKEN and A9_MINI_APP_URL environment variables to launch the Telegram Bot.")
    else:
        build_bot().run_polling()
