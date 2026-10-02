# Codex 交接文档

> 生成时间：2026-10-02。交接对象：接手 iFlowOne 工作的 Codex 会话。
> 本文件自包含，不需要历史聊天上下文。读完本文件后，再读
> `docs/EXECUTION-BOARD.md`（任务队列）与 `AGENTS.md`（仓库规则）。

## 0. 最重要的一件事：代码位置变了

三个仓库已从 `F:\i_Flow_One\` 根目录移入同一个文件夹：

```
F:\i_Flow_One\iFO\
├── iflow-connect\       通用接入层 / Core 契约（iflow-domain / iflow-protocol / iflow-adapter-sdk）
├── iflow-dsh-plugin\    插件（DSH Edge、A2A 桥、会话、面板）← 当前工作重点
└── iflowone-community\  Community Worker + Web + Hub UI
```

**三仓必须保持同级，不要拆散。** 跨仓引用是相对路径，依赖同级关系：

- `iFO\iflowone-community\apps\iflowone-web\package.json` 的 `fixtures:refresh`：
  `../../../iflow-connect/fixtures/slice-events.json`（上溯 3 层到共同父目录）
- `iFO\iflow-dsh-plugin\scripts\build.mjs` 的提示文本：`../iflow-connect/packages/*`

### 仓外有 4 处绝对路径配置（搬迁时已修好，路径再变就会坏）

| 文件 | 内容 | 断裂后果 |
| --- | --- | --- |
| `F:\i_Flow_One\deepseek-harness\.local\patches\iflow-dev.patch.yml` | `name: 'file:///F:/i_Flow_One/iFO/iflow-dsh-plugin/lib/index.js'` | 开发 profile 加载不到本地构建，**静默退回 GitHub 安装的旧副本** |
| `…\.local\patches\iflow-dev-commands.patch.yml` | 同一个 `file://` URL | 同上 |
| `…\.local\plugins\iflow\.git` | `gitdir: F:/i_Flow_One/iFO/iflow-dsh-plugin/.git/worktrees/iflow` | 该 linked worktree 的 git 操作全部失效 |
| `…\.local\plugins\iflow-dev\.git` | 同上（`worktrees/iflow-dev`） | 同上 |

这两个 worktree 是插件仓的 `git worktree` 挂载点（detached HEAD：`ed3d7ac` / `a6bd179`），
**不要删除**。它们不属于任何仓库，也不会被 git 自动修复。

运行时加载的是**安装副本**，不是源码：
`C:\Users\cp_66\.dsh\profiles\web\node_modules\iflow-dsh-plugin\`。
此前安装副本与旧构建哈希一致（`58048E8C67620E73`）。本轮重构仅更新源码和本地产物，未更新安装副本，不能再用旧哈希声称安装副本等于当前构建。

### 2026-10-02 重构更新

正式分工与最新架构见 `../iflow-connect/docs/handoff.md` 第 0 节：社区
**iFlowOne (iFO)**、通用接入层 **iFlow Connect**、具体插件 **iFlow DSH Plugin**。
A2A 和 ard-spec 只读参考。共享会话、发现和 A2A 代码已提取；插件
`src/runtime` 保存 DSH 专有集成；社区目录按节点区分同名 Agent；Web
发信仍使用对端本地 ID + DID。下文 S01 定位行号、旧基线测试数和哈希
是历史证据，需要在新模块中重新定位。架构重构当时未修复 S01 终态输出问题；随后本地修复已完成，见第 3 节。重构本身
未执行双机验证，无提交、推送、安装、重启或部署。

重构后本地验收：Connect 194、Community 113、Web 32、插件 412 项测试
通过（合计 751，0 fail），119 个隔离守卫变异被检出；ARD 参考 CLI
manifest / registry 均 PASS。完整记录在
`../iflow-connect/docs/refactor-validation-20261002.json`。社区新私有 Agent
作用域迁移 `0007` 只在本地 SQLite 测试执行，未来先迁移数据库再部署 Worker。

## 1. 仓库状态（交接时实测）

| 仓库 | 分支 | HEAD | 工作树 | 相对 origin/main |
| --- | --- | --- | --- | --- |
| iflow-dsh-plugin | `fix/conversation-tool-output-contract` | `77d396a` | **脏（22 项）** | 领先 1（docs 提交），落后 0 |
| iflowone | `docs/maintainer-handoff` | `3cab927` | 干净 | — |
| iflowone-ifo | `docs/maintainer-handoff` | `fdee67f` | 干净 | 落后 0 |

插件仓的 22 项包含本次未提交的统一发送实现、Conversation Service、面板改动、测试与
`lib/` 构建产物，以及未跟踪的 `docs/`、`scripts/check-*-guards.mjs`、
`src/conversation/service.ts`、`test/conversation-service.test.mjs`、`test/diagnostics/`。

**不要切换分支、reset、stash 或覆盖这些改动。** 交接前已核对：搬迁前后
分支 / HEAD / 22 项改动清单逐项一致。

## 2. 已完成并验证（可复现的证据）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 插件构建 | `npm run build`（在插件仓） | exit 0；`lib/index.js` SHA256 `58048e8c67620e7382cbace6c55551d08e2cb48809ac696c44120f6f78369fa9` |
| 插件前端 | `npm run build:client` | exit 0；`lib/client.js` SHA256 `508ee3f99261d5f15faca22ffefdaa15e6c32978f5d174c2d12f0094a9eb6a86` |
| 插件测试 | `npm test` | **391 passed / 0 failed / 0 cancelled** |
| 发送守卫变异 | `node scripts/check-send-guards.mjs` | exit 0，16 项变异全部被捕获 |
| Service 守卫变异 | `node scripts/check-conversation-service-guards.mjs` | exit 0，10 项变异全部被捕获 |
| Core typecheck | `pnpm typecheck`（iflowone） | 3/3 通过 |
| Core 测试 | `pnpm test` | **173 passed** |
| ifo typecheck | `pnpm typecheck` | 3/3 通过 |
| ifo 测试 | community / web | **92 / 25 全部通过** |
| Web 构建与生产一致性 | `pnpm --filter iflowone-web run build` | 产物与线上**逐字节相同**：903,453 字节，SHA256 `3F73394BA3A64AC5EF4C6590A45A0983`（CSS 亦相同） |

生产状态：`api.iflowone.com` Worker 已部署；D1 迁移 0006 已应用（`wrangler d1 migrations list --remote` 报无待应用项）；`agent.iflowone.com` 前端 = 上述构建产物。

## 3. S01/S02：终态输出缺陷本地修复完成（2026-10-02）

本地修复已完成，S01/S02 为 `READY_FOR_REVIEW`，主代理已审读代码，正在独立复跑全套回归；实机 S03 尚未执行。执行侧先成功构建，再通过 430 项测试（0 fail / 0 cancelled），新增 18 项发送方真实 bundle 回归；6 项新增守卫变异在隔离副本中全部捕获。未提交、推送、安装、重启或部署。

修复位置：`src/index.ts:2802-2803` 渲染区分 submitted 与 finished，并对缺失 error 兜底；`:3850`、`:3901` 即时/轮询终态失败均携带状态和原因，正常 COMPLETED 非空输出仍成功且无 error；`:3853` wait:false 不掩盖已经返回的失败终态。回归在 `test/conversation-bridge.test.mjs:418` 起，持续变异入口为 `npm run test:guards:terminal`。原诊断如今返回明确 error，渲染包含拒绝原因。

以下症状、旧定位行号及原诊断输出保留为修复前历史证据。

### 症状

对端拒绝一次会话后，发送方工具返回 `ok:false` 但**没有 `error` 字段**，
渲染结果为字面量 `iFlow call failed: undefined`（与对端曾报告的 `iFlow call failed: undefined` 一致）。

### 精确位置

- `src/index.ts:4437`：`ok` 以「`TASK_STATE_COMPLETED` 且 text 非空」计算
- `src/index.ts:4443`：**仅当 text 为空**才填 `error`
  → 终态为 REJECTED/FAILED/CANCELED **且 text 非空**时，`ok:false` 且无 `error`
- `src/index.ts:4487` + `src/index.ts:4493`：轮询终态分支，**同一模式**
- `src/index.ts:3151`：`render` 直接拼接 `value.error` → 输出 `undefined`

### 可达性链（已证实）

接收端拒绝首访时确实写入原因（`src/index.ts:2056`、`src/index.ts:2229` 的 `setStatus(..., 'TASK_STATE_REJECTED', reason)`），
而 `taskText`（`src/a2a/protocol.ts:59-66`）在无 artifacts 时回退读取 `status.message.parts` → text 非空。

### 复现方式（可再次运行）

```powershell
cd F:\i_Flow_One\iFO\iflow-dsh-plugin
$env:IFLOW_TEST_BUNDLE = (Resolve-Path lib/index.js).Path
node --test --test-name-pattern="DIAGNOSTIC" test/diagnostics/rejected-terminal-output.diag.mjs
```

实测输出：

```
DIAG execute result: {"ok":false,...,"state":"TASK_STATE_REJECTED","text":"This node is not accepting conversations from that agent."}
DIAG has error key: false
DIAG render output: [{"type":"text","text":"iFlow call failed: undefined"}]
```

该诊断脚本是**测试文件的副本**（改桩响应为 REJECTED + `status.message`），
放在 `test/diagnostics/` 下，不被 `npm test` 的 `test/*.test.mjs` 收集，不影响 391 个测试。
它不修改产品逻辑。

### 测试缺口

现有 REJECTED 用例（`test/conversation-bridge.test.mjs:637`、`:652`）只断言**接收端**状态，
没有任何发送方视角覆盖「非 COMPLETED + 非空 text」这一组合——所以全绿不能排除它。

### 同源的第二处展示问题

`src/index.ts:3149-3150` 只要返回值带 `taskId` 就渲染为 `remote task … finished (…)`，
因此 `waitForCompletion:false` 返回 `TASK_STATE_SUBMITTED`（`src/index.ts:4426`）会被显示成“finished”。

### 原修复建议（已在上述本地修复落实）

两个终态分支对**任何** `ok:false` 都给出原因（非 COMPLETED 时用状态 + text 组装），
`render` 在 `error` 缺失时兜底；同时补一个发送方视角用例（即上述诊断场景），
并对新守卫做变异检验（本仓要求：新守卫必须做变异测试并记录结果）。

## 4. 阻塞项：双机验收

看板 `S03`（两机 / 面板 / Web 统一聊天验收）仍为 `TODO`，原因是**对端 Node 不可达**：

- 本机当前 IP：`192.168.1.2`（另有 `172.23.112.1`，为虚拟网卡）
- 对端 peer `if-dsk` 注册为 `http://192.168.1.6:3080`，实测 **TCP 3080 不可达**

> 历史：更早时本机曾在 `10.10.11.109/23` 网段，与对端不在同一网段；现已回到 `192.168.1.x`，
> 但该 IP 上的 3080 端口仍无响应。需要用户确认对端机器是否开机、DSH 是否在运行、IP 是否变化。

验收参与者（**必须用精确参与者，不能用显示标签选择身份**）：

| 项 | 本机 | 对端 |
| --- | --- | --- |
| Agent ID | `rrt` | `weww`（显示名 `wwee`） |
| Agent DID | `did:key:z6MktzEtcs54J3MRqg36xT4uZdPotR5PwmHwnfwc8sSR2HAM` | `did:key:z6MknxTsYL3fZ3eR4U9EKUuJk22fFhvZYL8AJ67wpRSt9K43` |

正确 Conversation：`conv-c-mtesvya5-72rnlmqk`；待追踪 messageId：`msg-mtnuh0yg-c72vov20`；
对应 taskId：`iflow-task-mtnuh05t-az445zo3`。
错误旧线程 `conv-c-mtcnt8kt-cbj455j2` 属于 Gen-On-A，**不得复用**。

## 5. 硬性约束（不得自行执行）

- **不提交、不推送、不安装、不重启 DSH、不清数据、不改 peer pin/token/权限、不发布部署** ——
  这些都需要用户明确授权。提交/推送仅在被要求时执行，且当前不在 `main`。
- 不自动发送 Agent 消息或运行远端任务；需要实机动作时先列明 Agent、线程、次数、目的，交用户确认。
- 不上传正文、Workspace 路径、Session ID、密钥或 token；不把正文预览写进可发布 Journal。
- 不通过降级身份校验、绕过权限、切换默认 Agent、重建会话或清空历史来“拿到绿灯”。
- 生产部署另需授权：`wrangler deploy`、D1 迁移、启用 relay 是**三个独立决定**。
- 修改产品代码前后都要构建再测试；测试导入的是 `lib/index.js`，**构建失败或跳过会让测试跑旧产物**。

## 6. 本仓特有的陷阱（都曾真实踩到）

- 本仓按 CRLF 检出：`.js` 里用 `//.*` 配行尾锚点去注释**会静默失效**，要按 `/\r?\n/` 切分。
- `esbuild` 会 tree-shake 未使用的导出：bundle 里没有 ≠ 源码里没有。
- 新守卫必须做变异测试并记录结果——不会失败的守卫是装饰。
- 一条“禁止字符串”检查会命中解释“为什么没有它”的那句注释；去注释后要验证去注释真的生效。
- DSH 会话存储是拼接的 zstd 帧：`zstdDecompressSync` 只返回第一帧，扫到 0 条不等于存储为空。
- `src/repair/session-source.ts` 会写入 DSH 自己的会话存储，默认 dry-run，运行前 **DSH 必须关闭**，不要对运行中的安装执行。

## 7. 建议的第一步

1. `cd F:\i_Flow_One\iFO\iflow-dsh-plugin`，跑 `git status --short`、`git rev-parse HEAD`，
   与第 1 节表格核对；不一致就先查原因，**不要**切换分支或重置。
2. 构建 + 测试确认基线可复现：`npm run build` 与 `npm test`（当前期望 430 passed）。
3. 运行第 3 节的诊断脚本，亲自确认 `iFlow call failed: undefined`。
4. S01/S02 本地修复已完成；由主代理完成独立验收，后续安装、实机及发布动作按用户具体授权执行。
5. S03 双机验收等对端可达后再排期。
