#!/usr/bin/env python3
"""Unit tests for a9_bot.py round payload validation and rendering."""

import asyncio
import importlib.util
from pathlib import Path
import unittest


BOT_PATH = Path(__file__).resolve().with_name("a9_bot.py")


def load_bot_module():
    spec = importlib.util.spec_from_file_location("a9_bot_under_test", BOT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestA9BotRoundStates(unittest.TestCase):
    def setUp(self):
        self.mod = load_bot_module()

    def _run_case(self, payload):
        async def fake_fetch(_path, timeout=4):
            return payload

        self.mod.fetch_json = fake_fetch

        async def _collect():
            summary = await self.mod.current_round_summary()
            start_text = await self.mod.render_start()
            round_text = await self.mod.render_round()
            return summary, start_text, round_text

        return asyncio.run(_collect())

    def test_unavailable_and_malformed_payloads(self):
        cases = [
            None,
            {"bad": 1},
            ["bad"],
            [{}],
            [{"state": "STAKING_OPEN"}],
            [{"roundId": 0, "state": "STAKING_OPEN"}],
            [{"roundId": True, "state": "STAKING_OPEN"}],
            [{"roundId": 1}],
            [{"roundId": 1, "state": {}}],
            [{"roundId": 1, "state": ["STAKING_OPEN"]}],
            [{"roundId": "²", "state": "STAKING_OPEN"}],
            [{"roundId": "١", "state": "STAKING_OPEN"}],
        ]
        for payload in cases:
            with self.subTest(payload=payload):
                summary, start_text, round_text = self._run_case(payload)
                self.assertEqual(summary["status"], "unavailable")
                self.assertEqual(summary["state"], self.mod.PENDING)
                self.assertIn("暂不可达或返回数据异常", start_text)
                self.assertIn("暂不可达或返回数据异常", round_text)
                self.assertNotIn("蓄水筹备中", start_text)

    def test_unopened_payloads(self):
        for payload in ([], [{"roundId": 1, "state": "UNOPENED"}]):
            with self.subTest(payload=payload):
                summary, start_text, _ = self._run_case(payload)
                self.assertEqual(summary["status"], "unopened")
                self.assertEqual(summary["state"], self.mod.STATE_LABELS["UNOPENED"])
                self.assertIn("蓄水筹备中", start_text)

    def test_active_payloads(self):
        for round_id in (1, "2"):
            payload = [
                {
                    "roundId": round_id,
                    "state": "STAKING_OPEN",
                    "targetPriceUsdE8": "20000000",
                    "twap24hUsdE8": "10000000",
                    "qualifiedCandles": 8,
                }
            ]
            with self.subTest(round_id=round_id):
                summary, start_text, round_text = self._run_case(payload)
                self.assertEqual(summary["status"], "active")
                self.assertEqual(summary["round"], f"#{round_id}")
                self.assertEqual(summary["qualified"], "8/12")
                self.assertEqual(summary["twap_label"], "24H 参考均价")
                self.assertIn(f"#{round_id}", start_text)
                self.assertIn("24H 参考均价", start_text)
                self.assertIn("$0.2000", start_text)
                self.assertIn("8/12", round_text)

    def test_1h_price_preferred_over_24h_twap(self):
        payload = [
            {
                "roundId": 4,
                "state": "OBSERVING",
                "targetPriceUsdE8": "30000000",
                "priceUsdE8": "31500000",
                "priceValid": True,
                "twap24hUsdE8": "25000000",
                "qualifiedCandles": 9,
            }
        ]
        summary, start_text, round_text = self._run_case(payload)
        self.assertEqual(summary["twap_label"], "1H 均价")
        self.assertEqual(summary["twap"], "$0.3150")
        self.assertIn("1H 均价", start_text)
        self.assertIn("$0.3150", start_text)
        self.assertIn("9/12", round_text)


if __name__ == "__main__":
    unittest.main()
