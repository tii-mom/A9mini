# A9 官网 Cloudflare 发布

`a9-official-web` 是站点根目录。独立 Worker `a9-official-web` 在
`a9.lat/*` 与 `www.a9.lat/*` 提供新版官网。首页、红皮书、旧入口、代币元数据
及本版静态资源由新版提供。其他请求由 Cloudflare 转交原自定义域 Worker
`fuse-protocol`，包括 `/me`、`/leaderboard` 和 `/admin`。
`api.a9.lat` 和 `test.a9.lat` 使用各自的 Worker。

以下命令从 `a9-official-web` 执行，使用具备该项目发布权限的 Wrangler 会话。
`.assetsignore` 将部署源码与说明排除在静态资产之外。

## 上传预览版本

```sh
npx wrangler@4 versions upload --config cloudflare/wrangler.jsonc
```

在返回的版本预览地址检查首页、红皮书、沙盘和手机布局。版本预览地址下的旧站业务
路径返回 404，生产域名上的旧站路径继续由 `fuse-protocol` 提供。

## 发布正式站

记录当前线上版本 ID，再将已验收的版本设为 100% 流量。

```sh
npx wrangler@4 deployments list --config cloudflare/wrangler.jsonc
npx wrangler@4 versions deploy '<verified-version-id>@100%' --config cloudflare/wrangler.jsonc
```

发布后检查两个正式域名，验证 `/redpaper/`、`/greenpaper`、`/rules`、
`/a9.json`、`/#sandbox` 和旧站独立路径。检查 `/a9.json` 返回 JSON。

## 回滚

在 Cloudflare 控制台的 Workers 和 Pages 打开 `a9-official-web`。
如果只回退本次更新，在部署记录中选中上一可用版本并回滚。

如需恢复旧官网，在域和路由中移除 **新版 Worker** 的
`a9.lat/*` 与 `www.a9.lat/*` 两条路径路由。原自定义域会继续把请求交给
`fuse-protocol`。回滚后再检查两个正式域名。
