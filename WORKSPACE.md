# 工作区：dsh-mnemosyne

Mnemosyne（谟涅摩绪涅）— DSH 的预测式记忆召回插件 + 中心化记忆服务器。
这个目录同时是**插件源码仓库**和**DSH 工作区**。

- DSH 工作区 ID：`be218110-4310-4eb2-9688-269251d8b226`
- 工作区标题：`dsh-mnemosyne`
- git remote：`https://github.com/dingdadao/Mnemosyne.git`（分支 `main`）
- 插件名（`plugin/package.json`）：`dsh-mnemosyne@1.0.0`

## 三条链路（别搞混）

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 源码 | `<本目录>/plugin/index.js` | 改这里 |
| 运行副本 | `~/.dsh/profiles/desktop/node_modules/dsh-mnemosyne/index.js` | **DSH 真正加载的**，拷贝，不是软链 |
| 服务端 | `https://mnemosyne.niao.fun`（`10.0.0.33:8790`） | 远程部署，SQLite + 检索 |
| 命令行 | `~/.dsh/profiles/desktop/cordis.patch.yml` | 唯一带真 token 的地方 |

**token 只存在于 profile 的 `cordis.patch.yml`。** 仓库里的 `plugin/cordis.patch.yml` 是带
`process.env.MNEMOSYNE_URL` 的模板，同步时永不覆盖 profile 那份。

## 常用命令

```bash
./run.sh check        # 一站式自检：运行时 / 服务端 / 漂移 / 测试 / git
./run.sh test         # 插件单测（node --test，11 项，不联网）
./run.sh sync         # 先测后同步：仓库源码 → profile 运行副本（带备份）
./run.sh restore      # 回滚 profile 插件到上一次同步前
./run.sh server       # 本地起服务端 127.0.0.1:8790
./run.sh smoke        # 用生产 url/token 跑 deploy/smoke-test.sh
./run.sh init         # 幂等注册/修正本仓库的 DSH 工作区条目
```

改完源码的完整流程：`./run.sh sync` → **完全退出 DeepSeekRuntime 再启动** → `./run.sh check`。
热更不会生效：插件是在进程启动时 import 的。

## 目录

```
plugin/          DSH 插件（index.js 是主体，cordis.patch.yml 是插入配置模板）
plugin/index.test.mjs   11 项单测，假 ctx + 替身 fetch，不依赖宿主
server/          中心化服务器（index.js 路由、db.js schema、search.js 检索、brief.js 首轮简报）
deploy/          install-server / install-plugin / smoke-test / 迁移脚本
plugins/memory/  Hermes 侧的 Python 插件
docs/            设计文档（credentials-vault、design-review-hindsight）
scripts/         工作区脚本（check / dev-sync / register-workspace / lib）
run.sh           上表的入口
.backups/        同步前的插件备份（git 忽略）
```

## 当前状态（2026-11-11）

- 服务端 `3.0.0-multi-tenant` 在线，65 条记忆；`POST /memory/brief` 已部署（v4 首轮简报）
- 插件 11 项单测通过；仓库源码与运行副本已对齐（把 profile 里已验证的
  `renderBriefFromItems` 本地合成降级回流进了仓库）
- `main` 领先 `origin/main` 1 个提交（`808594b v3.3-B`），另有 README/SKILLS/deploy/server 的未提交改动
- git 全局配了 `http.proxy=127.0.0.1:7890`，代理没开时会连不上 GitHub；本仓库已用
  `git config --local http.proxy ""` 直连覆盖

## 已知坑

1. **profile 副本才是运行中的代码。** 只改仓库文件不会有任何效果，一定要 `./run.sh sync` + 重启。
2. **workspace.json 有竞态。** DSH 运行时也会写 `~/.dsh/storages/workspace.json`；
   `./run.sh init` 按 realpath 去重并留 `.bak-时间戳` 备份，注册后重启 GUI 最稳。
3. **`POST /memory/brief` 返回空 text 不等于坏了。** 空 = 本轮不值得注入，是设计内行为；
   插件遇到 404/空体会走 search+recent 本地合成。
4. **server/node_modules 已安装但不入库**（含 better-sqlite3 原生模块）。新机器先 `cd server && npm install`。
5. **不要 `node --test plugin/`（目录形式）**：只报 1 个聚合项，看不出失败用例。用文件路径。
