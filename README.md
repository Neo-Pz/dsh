# iFlow — DSH 双向 Agent2Agent (A2A) 桥

iFlow 是一个运行在 DeepSeek Harness（DSH）上的**本地 Cordis 插件**（Host 端），基于 Google 捐赠给
Linux 基金会的 [Agent2Agent (A2A) 协议](https://github.com/a2aproject/A2A)（JSON-RPC 2.0 绑定）。

它让**两台不同电脑上的 DSH**（双方都安装并运行此插件）能够**双向调用**对方：

- **入站**：对方 DSH 通过 A2A `SendMessage` 把任务发过来，本机起一个**子 agent** 执行（拥有本机全部
  工具：文件、命令、网页、搜索等），完成后把最终答案写回 Task 工件，对方通过 `GetTask` 轮询取回。
- **出站**：本机模型通过 `iflow_send` 工具把任务发给对方（注册的 peer），等待对方 agent 执行完成并
  取回答案。两端插件相同，天然对等；还支持 A → B → A 链式传递。

## 文件位置

| 文件 | 说明 |
| --- | --- |
| `src/index.ts` | 插件完整 Host 源码（Loader 直接加载的本体，v20） |
| `cordis.patch.example.yml` | 复制到 Harness 的 `.local/patches/` 后填写绝对模块 URL 的启动 patch 示例 |
| `.local/patches/iflow*.patch.yml` | Harness 工作区内的本机启动 patch（`--patch` 加载，稳定版和开发版各一份） |
| `DEVELOPMENT.md` | 本地开发、验证、发布和回滚流程 |
| `package.json` | 本地插件包声明（name/main/type） |
| `README.md` | 本说明 |
| `DESIGN.md` | iFlowOne 设计文档（信任根 P1 / 委托 P2 / 经济 P3 路线） |
| `rust/` | Rust `iflow-id` 参考实现源码（`cargo build --release` 生成 exe） |
| `rust/target/release/iflow-id.exe` | Rust 构建产出的二进制（插件经 `ctx.subprocess` 调用，不提交） |

## 加载方式（正式插件，重启不丢）

iFlow 现在是**本地正式插件**，用 `--patch` 加载，**不是**动态插件（不再是 `cordis_define` 每次重启重新定义）：

```powershell
cd F:\i_Flow_One\deepseek-harness
pnpm dsh web --patch ./.local/patches/iflow.patch.yml --no-open --port 0
```

`.local/patches/iflow.patch.yml` 里的插件路径是 `file:///F:/i_Flow_One/...` 形式（Windows 下 ESM loader 必须用
`file://` URL），插件行 `id: iflow` 会出现在 Web 的「设置 → 插件」列表，状态「已挂载」。

维护流程见 [DEVELOPMENT.md](DEVELOPMENT.md)。

> 若 3080 被占（`listen EACCES`），先用随机端口确认无冲突：`pnpm dsh web --patch ... --port 0`，
> 从日志读取实际端口，再换回固定端口正式启动。

## 快速开始（两台机器各自执行）

### 1. 确保 DSH Web 服务器可被对方访问

DSH web 默认绑定 `127.0.0.1`，且 CLI 会**拒绝** `--host 0.0.0.0`
（"intentionally not supported for safety"）。正确做法是写用户级 profile patch：

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（DSH_HOME 默认 `~/.dsh`；文件已存在且内容为 `[]`）：

```yaml
- id: webserver
  config:
    host: '0.0.0.0'
    port: !!js ctx.webStartup.port ?? 3080
```

注意：这是对 webserver 行的**整段 config 替换**，`port` 必须一并写上。
保存后**重启 dsh web** 生效（可用 `netstat -ano | findstr 3080` 确认从
`127.0.0.1:3080 LISTENING` 变为 `0.0.0.0:3080 LISTENING`）。

> 仅建议在可信内网这样做；公网请改用 SSH 隧道 / 反向代理 / Tailscale，并开启共享 token（见下）。

### 2. 本机（A）注册对端（B）

在本机会话中调用（模型可直接用这些工具，也可在 GUI 里让 agent 执行）：

```
iflow_add_peer(name="machine-b", url="http://<B的IP>:3080")
```

对端（B）以同样方式注册 A：

```
iflow_add_peer(name="machine-a", url="http://<A的IP>:3080")
```

### 3. 调用

- 查看本机端点：`iflow_status`
- 发现对端能力：`iflow_discover(peer="machine-b")`（读取对端 `/.well-known/agent-card.json`）
- 派发任务并等待结果：`iflow_send(peer="machine-b", prompt="检查 B 机器的工作区并总结内容")`
- 只启动不等结果：`iflow_send(peer="machine-b", prompt="...", waitForCompletion=false)`
- 管理：`iflow_list_peers` / `iflow_remove_peer(name=...)`

对端收到消息后，会以全新子 agent 处理该 prompt，该子 agent 拥有对端机器的**全部本地工具**，
所以能真正操作对端电脑（读写文件、执行命令等），而不是只会聊天。

## A2A 端点（标准兼容）

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/.well-known/agent-card.json` | GET | AgentCard 发现（IANA 标准 well-known URI；另提供 `/.well-known/agent.json` 兼容别名） |
| `/a2a` | POST | JSON-RPC 2.0：`SendMessage` / `GetTask` / `CancelTask` / `ListTasks` / `GetExtendedAgentCard`(未支持) |

- 协议绑定：`JSONRPC`，`protocolVersion: 1.0`；JSON 字段为 camelCase（规范 §5.5）
- 任务状态：`TASK_STATE_SUBMITTED → WORKING → COMPLETED / FAILED / CANCELED`
- 错误码：`-32001` TaskNotFound、`-32002` TaskNotCancelable、`-32004` UnsupportedOperation（规范 §5.4）
- 也兼容任何第三方 A2A agent（如官方 Python SDK 写的 agent），不限于 DSH

## 安全

- **默认完全开放**（`auth off`）：任何能访问 `/a2a` 的人都能让本机起 agent 执行任务。请务必在可信
  网络使用或开启认证。
- **开启共享 token（两端设置同一个值）**：

  ```
  iflow_set_token(token="你的共享密钥")     # 两端都执行，值相同
  ```

  之后入站请求必须带 `Authorization: Bearer <token>`，出站自动附带。
  对端单点 token 可在 `iflow_add_peer` 里用 `token` 参数覆盖。
- 入站任务在**本机现有权限策略**下运行：子 agent 的工具调用同样受沙箱/审批约束。
- 公网环境务必：HTTPS（经反代或隧道）、强 token、必要时用 `iflow_set_public_url` 指定对外地址。

## 已知限制（v1）

- 动态插件：进程重启后需重新定义（源码保存在 `iflow-plugin.js`）；peer/token/任务记录都在内存中。
- 每次 `SendMessage` 都是全新任务，暂不支持多轮会话续接（`taskId` 续聊未实现）。
- 不支持流式（`SendStreamingMessage`）、推送通知（pushNotifications）与扩展 AgentCard。
- 单任务超时 10 分钟；`iflow_send` 默认等待上限 10 分钟（`maxWaitSeconds` 可调，最高 3600）。
- 出站 HTTP 依赖本机 `curl`（Windows 10 1803+ 自带；macOS/Linux 通常自带）。
- 子 agent 若需要人工审批才能用某个工具，而远端无人应答，任务会卡到超时 —— 请让远端任务只使用
  其权限范围内的操作。

## 架构速览

```
┌─ DSH A ─────────────────────────────┐        A2A / JSON-RPC 2.0        ┌─ DSH B ─────────────────────────────┐
│ 模型 ──iflow_send──► curl ──────────┼── SendMessage / GetTask ─────────►│ /a2a 路由 ──► dispatch ──► 子 agent │
│  iflow_* 工具（出站）                │◄────────── task/artifact ─────────│  (agents.create + 本机全部工具)     │
│  /a2a 路由 ◄── SendMessage ◄────────┼───────────────────────────────────┼── iflow_send ◄── 模型               │
│  AgentCard @ /.well-known/...       │                                   │  AgentCard @ /.well-known/...       │
└─────────────────────────────────────┘                                   └────────────────────────────────────┘
```

入站消息处理：`handleSendMessage` 创建 Task → `agents.create` 生成全新子 agent（会话 `iflow-*`，
工作目录 = 本机 workspace）→ `followup` 注入 prompt → `whenIdle` 等完成 → 折叠最终输出为工件 →
状态置 `COMPLETED`。`returnImmediately` 为 true 时立即返回 `SUBMITTED`，客户端轮询 `GetTask`。

## 技术要点（踩坑记录）

- 动态 Host 沙箱**没有** `fetch`/`require`/`process`/`setTimeout`/`AbortController`。出站 POST 走
  `ctx.subprocess` + curl；GET 走 `ctx.web.fetch`（仅 GET）；定时用 `ctx.timeout`；取消用自实现的
  最小 AbortController polyfill（host 侧 `agents.create` 只用到 `aborted/reason/事件/throwIfAborted`）。
- 工具 `output.schema` 必须用 DSH 值 schema DSL：对象必须显式 `additionalProperties`，`required`
  是属性上的 `required: true`，不允许 `type: [...]` 数组（用 `oneOf` 表达可空）。
- **崩溃教训**：`runChild` 曾从 `state.outgoing` 反查 controller，而条目在调用后才插入 → 同步
  TypeError → 未处理 rejection 打崩整个 DSH 进程。修复：controller 作参数传入、先插条目再启动、
  给 `done` 挂 no-op catch、HTTP handler 全部 try/catch。
- **子 agent 模型路由**：`agents.create` 传空 `agentOptions: {}` 会让子 agent 以
  `turn/end(reason:error)` 结束且不产出任何消息 —— agent-loop 要求显式 `provider`/`model`
  （否则抛 "has no provider/model"）。修复：注入 `agentDefaultModel`，用
  `ctx.agentDefaultModel.currentSelection()` 取 `{provider, model}` 传给子 agent。
- **`iflow_discover` 不要用 `ctx.web.fetch`**：部分部署没有注册 web fetch provider
  （"no usable web provider"）。修复：AgentCard 发现改走 curl（`curlGet`），与 `iflow_send` 一致。

## 双机联调实录（if-lt ↔ if-dsk，2026-08 实测）

两台真实机器（同 WiFi 局域网）完成双向互调闭环的经验：

| 项 | 实测结果 |
| --- | --- |
| 网络 | if-lt `192.168.1.3`、if-dsk `192.168.1.4`，均 `0.0.0.0:3080` |
| token | 两端 `iflow_set_token` 设**同值**；出站自动带 Bearer，入站校验，缺一端即 401 |
| 双向 | if-lt→if-dsk ✅、if-dsk→if-lt ✅、A→B→A 链式闭环 ✅ |
| 远端能力发现 | `iflow_discover(peer=...)` 读取对方 AgentCard 正常 |

**联调踩坑：**

1. **`--host 0.0.0.0` 被 CLI 硬拒绝**（safety 理由），只能通过 profile patch 改 webserver
   config（见上文第 1 步）。改完必须重启进程；`netstat` 确认 `0.0.0.0:3080 LISTENING`。
2. **日志里的 LAN 地址可能是误导**：本机同时存在 VMware 虚拟网卡时，启动横幅可能显示
   APIPA 地址（如 `169.254.51.151`，不可路由）。真实局域网地址以 `ipconfig` 的 WLAN/以太网
   条目为准（如 `192.168.1.3`）。AgentCard 的 interface URL 由请求方 Host 头推导，所以对端
   用真实 IP 访问即可得到正确 URL。
3. **进程重启后内存态清零**：token、peer 注册、任务记录都丢。本环境实测重启后动态插件
   定义被保留（可能与部署的持久化有关），但不要依赖——按 `iflow-plugin.js` 重新
   `cordis_define` + `cordis_run` 最稳妥，然后重设 token、重注册 peer。
4. **对端子 agent 可能没有文件/命令工具**：实测 if-dsk（静态 bundle 版）上，iFlow 起出的
   子 agent 只有 `iflow_*` 通信工具，无 shell/fs，无法执行跨机文件检查。若需要远端操作
   文件，要确保对端会话/子 agent 启用了文件与命令工具（或在远端主会话直接执行）。
5. **任务语义**：`SendMessage` 每次起全新子 agent，无多轮记忆；`returnImmediately: true`
   时客户端轮询 `GetTask` 取结果（iFlow 客户端默认这么做）。
6. **安全**：`0.0.0.0` + 同网段 = 网段内设备可触达 `/a2a`，token 是唯一防线；
   公网/不可信网络务必换 Tailscale 等加密虚拟局域网。

## 版本一致性（统一基线）

> 现状（2026-08 实测）：两端曾**各自分叉升级**——本机（if-lt）动态插件迭代到 v8，
> 对端（if-dsk）静态 bundle 停留在基础 8 工具版。协议互通不受影响，但增强功能不同步。

**基线约定**：`src/index.ts` 是本项目**唯一权威源码**。任何功能升级先改它、两端验证，
再同步对端 bundle。

**对端（静态 bundle 版）相对基线的差异与升级清单**：

| 能力 | 基线（本机 v8） | 对端（基础版） | 对端需补 |
| --- | --- | --- | --- |
| 工具数 | 9（含 `iflow_set_alias`） | 8 | `iflow_set_alias`（备注名） |
| 出站 metadata | `{from, machine}` | 无 | 出站带 `metadata.from`/`metadata.machine` |
| 会话命名 | `iFlow · <from>`（sessionTitle.rename） | 无 | 入站子 agent 会话 rename |
| 原始对方信息 | task.metadata: from/machine/prompt/receivedAt | 无 | 入站任务记录 metadata |
| iflow_status | 10+ 字段（alias/machine/name/version...） | 5 字段 | 补 name/version/alias/machine/host/port |
| 终态任务短路 | ✅ | ✅ | 已对齐 |
| 子 agent 工具集 | 仅 iFlow 工具（同） | 仅 iFlow 工具 | 一致 |

**同步步骤（对端）**：把 `iflow-plugin.js`（v8）逻辑移植进对端 bundle 的
`lib/index.js`（注意静态环境用 `defineTool` + `ctx.tools.register`，动态沙箱才是
`harness.defineTool`），然后重新打包/加载并重设 token/peer。

## 自托管更新源（方案 B，v10）

> 不依赖第三方托管：任一端作为"源"，另一端本地主动拉取 + 版本校验 + 人工确认加载。
> **禁止协议内远程推送代码**（= 给网段内任何人远程代码执行能力）；同步永远是本地主动拉取。

**源端点**（挂在本机 webServer，受与 `/a2a` 相同的 Bearer token 保护）：

| 端点 | 说明 |
| --- | --- |
| `GET /iflow/version.json` | 版本元数据：`{version, sha, updatedAt, size, source}` |
| `GET /iflow/latest.js` | 权威源码全文（text/plain，即当前 worktree 的 `src/index.ts`） |

**工具**：

- `iflow_update_check(peer)`：拉对端 `/iflow/version.json`，对比本机 `syncVersion`/源码 sha，报告同步/落后
- `iflow_pull(peer)`：仅开发 worktree 可用；拉对端 `/iflow/latest.js`，写入本机 `src/index.ts`（生效仍需重启插件）

**流程**：
1. 本机改代码 → 更新 `syncVersion`（插件内常量）→ 把 `iflow-plugin.js` 同步到本机
   `sandboxPolicy.workspaceRoot` 下（更新源从此路径读）→ 重新 define/run
2. 对端 `iflow_update_check(peer="if-lt")` → 落后 → `iflow_pull(peer="if-lt")` → 重新加载
3. 升级后 `syncVersion`/sha 一致即两端对齐

**对端（静态 bundle）升级到 v10 需补的增量**（相对已发它的 v9 源码）：
1. `inject` 增加 `'fs'`；顶部加 `sourcePath = ${workspace}/iflow-plugin.js`
2. `state` 增加 `syncVersion`（如 `'10'`）、`updatedAt`（用内联 `new Date().toISOString()`，勿引用后声明的 `iso`——TDZ 坑）
3. 新增 `simpleHash()`（FNV-1a）与 `readSource()`（`ctx.fs.resolve`+`readText`）
4. 新增两个路由 handler `versionHandler`/`latestHandler`，`webServer.register` 注册
   `/iflow/version.json`、`/iflow/latest.js`（均校验 `authorized(req)`）
5. `iflow_status` 输出加 `syncVersion`/`updateEndpoint`；新增 `iflow_update_check`/`iflow_pull` 工具

**已知限制**：大消息（>~30KB 源码）塞单个 curl 参数会 `ENAMETOOLONG`——v10 起用
`/iflow/latest.js` 拉取源码（GET 走 stdout，无长度限制），替代手工分段传输。

## 变更记录

- **P2 委托层硬化（V20，独立于插件版本号）**：按 P2-GRANT-PROTOCOL 评审结论落地三项增量——
  **root-strength 检查**（`grant.eval` 把 `issuer_root.kind` 纳入级别上限：H1→L0、H2→L2、H3→L3；
  弱根可被显式 `root_ack` 提升，但 `root_ack` 本身必须由 H2+ 根签名——"低根不能自己给自己提权"）、
  **check-at-use 吊销注册表**（Reg-L 本地注册表 `~/.iflow/revocations.json`，`grant revoke`/`grant status`
  子命令；判定时按其 check，`revocation_grace` 默认 60s，宽容窗内 L1+ 一律拒绝、L0 放行并告警）、
  **capabilities 字段**（授权书以命名空间前缀能力集 `iflow.cap:<域>.<操作>` + `deny` 取代/补充旧的
  业务 `scope`；裸自由式能力 ID 被拒绝，`evaluate` 对 `capabilities`（否则回退遗留 `scope`，否则基线
  `iflow.cap:agent.run`）做 deny 优先的限定）。新增字段用 `skip_serializing_if` 保持 V19 授权书
  `grant_id` 稳定（严格可加性）。插件 `validateCapabilityId`/`normalizeAction` 校验能力 ID，
  `iflow_grant` 工具增加 `revoke`/`status` 动作与 create 的 `capabilities`/`root` 参数；任务 metadata
  记录 `grantCapabilities`/`grantIssuerRoot`。**特性**：`// 裁决` —— 开放问题 1-5 均已拍板
  （H1 严格 L0-only + root-ack、社区注册表 + 命名空间前缀、Reg-L 优先 + Reg-C 异步 + 60s grace、
  action↔body 语义关联在协议层、强制在校验 Shim、P3 由 ifo 结算方写 merkle anchor + grant_id 进证据包）。
- **P2 委托层（V19，独立于插件版本号）**：`iflow-id grant` 子命令实现授权书——
  `grant create`（人签授权书给 agent：scope/预算/时长/L0-L3 级别）、`grant verify`（验签+id）、
  `grant eval`（全链检查：签名/ID/过期/等级/范围）。**L3 越权会以非零退出**，插件可据此拒绝。
  插件 v19 入站支持 `X-IFlow-Grant` 头：签名请求可携带授权书，验签（P1）+ 分级检查（P2），
  越权（L1 授权书请求 L3 动作）→ 401 拒绝，grantId/level/delegate 记入任务 metadata。
  新增 `iflow_grant` 工具（create/verify/eval）。11/11 单测通过。
- **P1 信任根（V18，独立于插件版本号）**：新增 `iflow-identity/` Rust 参考实现——
  `iflow-id` CLI：`create`（did:key 生成+持久化 `~/.iflow/identity.json`）、`show`、
  `sign`（规范化请求行 `method\npath\nsha256(body)\nnonce\ntimestamp` 签名）、`sign-file`、
  `verify`、`agentcard-sign`/`agentcard-verify`（AgentCard JWS，EdDSA，key 排序规范化）、
  `replay-check`（300s TTL + 持久 nonce 缓存 `~/.iflow/nonces.json`，跨进程防重放）。
  支持 `--home <dir>` 把存储定位到沙箱可写根内。11/11 单测通过。动态插件沙箱无 Web Crypto，
  插件经 `ctx.subprocess` 调用本二进制。
- **v18 插件集成（M2/M3）**：`/.well-known/agent-card.json` 携带 `identity.did`；
  新增 `/.well-known/agent-card.signed.json`（JWS，可被 `iflow-id agentcard-verify` 验签）；
  出站 `/a2a` 自动签名（`X-IFlow-Signature` 信封，best-effort）；入站验签 + 防重放
  （伪造/重放 → 401，验签通过记录 `signerDid` 到任务 metadata）；新增 `iflow_identity`
  工具（status/ensure/verifyPeer）；入站子 agent 默认跑 `remote-a2a` 受限预设
  （仅工作区 fs + todo，无 shell/子代理/web），缺失时回退 `standard`。
- **已知问题（已修复 2026-08-21）**：入站任务子 agent 一度空输出——根因是本机
  `~/.dsh/settings.yaml` 的 `agent-default-model` 曾被设为 `zai-coding-cn/glm-5.2`
  （无对应 adapter）。修复：改为 `provider: deepseek-official` +
  `model: deepseek-v4-flash-vision-exp`（与当前会话路由一致，已验证子 agent 在
  `remote-a2a` 预设下正常完成并返回 artifacts）。若日后改默认模型，务必用
  `llm-pi-ai.providers` 或 `llm-deepseek` 中已注册的 provider/model。
- **v11**（2026-08）：`iflow_pull` 增加**内容校验**——拉取 payload 必须以 `//`、`/*` 或
  `return {` 开头（真实 JS 源码）才写入，拒绝 SPA HTML/JSON 错误体。
  背景事故：v10 时本机子 agent 误对未升级对端执行 `iflow_pull`，对端无 `/iflow/latest.js`
  返回了 DSH 前端 index.html，子 agent 把 HTML 写进 sourcePath 污染了更新源（`/iflow/latest.js`
  短暂返回 HTML）。教训：**拉取类工具必须校验 payload 类型，不能盲写文件**。
- **v10**（2026-08）：自托管更新源（方案 B）：`/iflow/version.json` + `/iflow/latest.js`
  端点 + `iflow_update_check`/`iflow_pull` 工具；`iflow_status` 增加 `syncVersion`/`updateEndpoint`。
- **v9**：修复 v8 的 TDZ bug（`handleSendMessage` 中 `metadata`/`from` 在 task 对象创建后才声明）。
- **v8**：原始对方信息记录机器原名（`metadata.machine`，`hostname` 命令获取），与备注名 `from` 并存。
- **v7**：入站任务记录原始对方信息（from/prompt/receivedAt 于 task.metadata）。
- **v6**：入站子 agent 会话命名 `iFlow · <from>`（sessionTitle.rename）；`iflow_set_alias` 工具。
