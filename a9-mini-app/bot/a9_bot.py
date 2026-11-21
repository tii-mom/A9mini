#!/usr/bin/env python3
"""
A9 Telegram Bot Companion Service (Implements a9_telegram_bot.md)
Supports all 7 BotFather commands (/start, /round, /position, /team, /claim, /rank, /help)
and deep-linking WebApp inline keyboard buttons.

Usage:
  export A9_BOT_TOKEN="your_botfather_token"
  export A9_MINI_APP_URL="https://your-deployed-domain.com"
  pip install python-telegram-bot>=21.0
  python3 bot/a9_bot.py
"""

import os

BOT_TOKEN = os.getenv("A9_BOT_TOKEN", "")
MINI_APP_URL = os.getenv("A9_MINI_APP_URL", "https://t.me/A9Terminal_bot/app")

TEMPLATES = {
    "start": (
        "⚡️ *A9 // TON QUANTUM TERMINAL* ⚡️\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "欢迎接入 *A9* 链上自动化挑战协议。基于 TON 主网智能合约与高频预言机驱动。\n\n"
        "📊 *当前轮次状态*：`ROUND #03` (观察阶段)\n"
        "🎯 *走廊基准线*：`$0.1850 USD`\n"
        "📈 *实时 24H TWAP*：`$0.1895 USD` (+2.43%)\n"
        "🔥 *全网质押总额*：`5,200,000 TON` (池子：700M A9)\n\n"
        "您的专属节点已就绪，立即启动终端进入实盘博弈："
    ),
    "hourly_candle": (
        "🟢 *A9 预言机定盘通知 // 第 16/24 根收盘*\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "第 16 根 1H K 线已正式在链上锁定归档！\n\n"
        "• 目标考核底价：`$0.1850 USD`\n"
        "• 本小时收盘均价：`$0.1910 USD` (▲ 阳烛达标)\n"
        "• 累计达标统计：*12 根达标* / 16 根必须 (剩余 8 根)\n"
        "• 当前达标概率模型：`94.2% HIGH_BULLISH`"
    ),
    "settlement": (
        "🎉 *第 3 轮挑战成功达标！收益流星已就绪* 🎉\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        "本轮最终达标根数 *18/24*（达成率 112%），700M A9 奖池全额激活！\n\n"
        "• 质押本金：`5,000 TON` (安全保本解冻)\n"
        "• 本轮总收益：`1,260,000 A9` (倍率 2.15x)\n"
        "• 🟢 *即刻可领 (20%)*：`252,000 A9`\n"
        "• 🔒 *线性释放 (80%)*：`1,008,000 A9`"
    ),
}


def build_bot():
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
    from telegram.ext import Application, CommandHandler, ContextTypes

    async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
        kb = InlineKeyboardMarkup([
            [InlineKeyboardButton("🚀 启动 A9 交易终端 (Mini App)", web_app=WebAppInfo(url=MINI_APP_URL))],
            [InlineKeyboardButton("⚡ 滑动立即提取奖励", web_app=WebAppInfo(url=f"{MINI_APP_URL}?startapp=claim"))],
        ])
        await update.message.reply_text(TEMPLATES["start"], parse_mode="Markdown", reply_markup=kb)

    async def cmd_round(update: Update, context: ContextTypes.DEFAULT_TYPE):
        kb = InlineKeyboardMarkup([
            [InlineKeyboardButton("📊 查看实时 24H 走廊雷达", web_app=WebAppInfo(url=f"{MINI_APP_URL}?startapp=proof_R03_088921"))]
        ])
        await update.message.reply_text(TEMPLATES["hourly_candle"], parse_mode="Markdown", reply_markup=kb)

    async def cmd_claim(update: Update, context: ContextTypes.DEFAULT_TYPE):
        kb = InlineKeyboardMarkup([
            [InlineKeyboardButton("⚡ 滑动提取 252,000 A9", web_app=WebAppInfo(url=f"{MINI_APP_URL}?startapp=claim"))]
        ])
        await update.message.reply_text(TEMPLATES["settlement"], parse_mode="Markdown", reply_markup=kb)

    async def cmd_simple(update: Update, context: ContextTypes.DEFAULT_TYPE):
        cmd = (update.message.text or "").split()[0].lstrip("/")
        route_map = {"position": "proof_R03_088921", "team": "invite_UQ9921_8892", "rank": "warmup", "help": ""}
        param = route_map.get(cmd, "")
        url = f"{MINI_APP_URL}?startapp={param}" if param else MINI_APP_URL
        kb = InlineKeyboardMarkup([[InlineKeyboardButton(f"打开 A9 /{cmd} 终端视图", web_app=WebAppInfo(url=url))]])
        await update.message.reply_text(f"⚡️ A9 终端指令 `/{cmd}` 已就绪，请点击下方入口查看实时链上数据：", parse_mode="Markdown", reply_markup=kb)

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
