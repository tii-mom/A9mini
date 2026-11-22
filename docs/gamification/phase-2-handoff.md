# 第二阶段交付与独立验收

基线为 `05842abf261aa9938bbc1b9f4445fa4e8190be4a`。此报告随第二阶段提交，验收结论由项目负责人独立确认。

- `assets/game-v2/city.webp` 为竖屏背景，沿用现有 A1 近景图层。四个 `gate-*.webp` 为透明入口，裁去透明外边距并压缩，配合文字链接和轻量反馈。背景及四个入口合计约 288 KiB（磁盘占用）。
- 三张透明 `crystal-*.webp` 在奖励宝库标为美术预览，展示初阶、星辉、传说三种轮廓。风格板、界面样板和首页合成参考放在 `style-samples/`。运行时素材使用 WebP，原图保存在本地美术收件目录。
- `game.css` 复用现有页面和组件样式，统一场景、面板和底栏色板。建筑与晶体保留立体材质并使用轻阴影描边。
- `app.js`、`i18n.js` 和 `router.js` 更新双语导航与页面归属，URL 保持兼容。`pages/wealthverse.js` 增加可点击建筑和商行直达入口，保留星盘入口、身份图鉴和业务页面。
- `9c334d7` 的 `worker/src/toncenter.mjs` 及 `worker/tests/p0-security.test.mjs` 包含 TonCenter 结构校验与反例回归。钱包、身份、兑换业务、合约和生产配置沿用基线。

## 测试

```sh
node --test a9-mini-app/js/*.test.mjs worker/tests/*.test.mjs
A9_PORT=18761 node a9-mini-app/dev-server.mjs
A9_TEST_URL=http://127.0.0.1:18761 A9_SCREENSHOTS=output/phase-2-acceptance node a9-mini-app/tests/wealthverse-browser.mjs
```

浏览器脚本需要 Playwright 与 Chromium。可分别通过 `PLAYWRIGHT_MODULE` 和 `CHROMIUM_PATH` 传入本机路径。原始输出、页面截图与测试记录见 [phase-2-evidence](phase-2-evidence/)。Chromium 验证覆盖 390×844 中文、360×780 英文、旧路由、四个建筑链接、商行入口、水晶预览、图片失败及真实模式隔离。真实模式使用隔离接口验证。

待独立验收项包括 Telegram iOS/Android 真机安全区、低端机帧率及真实弱网加载耗时。

## 前端视觉复核更新

主城从负责人选定的贴纸样品中提取角色插画，轮次状态、按钮及文字独立渲染。底栏承担四个主栏目导航，主城内的贴纸入口分别通往商行、奖励、排行和规则。共享面板及场景标题采用深紫底、暖金分隔和奶油色文字。两种手机视口的 52 项页面检查已重新通过，上列证据目录中的截图已更新。
