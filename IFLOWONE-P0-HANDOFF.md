# iFlowOne P0 交接书：Stable Principal 与私密 Web 对话

> **状态：实施规格。** 本文件是 P0 的唯一交接入口，供 Claude Code 按切片实施。
> 它收敛三仓边界，不替代 [IFLOWONE-ARCHITECTURE.md](IFLOWONE-ARCHITECTURE.md)、
> [DESIGN.md](DESIGN.md) 或各仓 README。冲突时，以本文件的 P0 隐私、身份和
> 交接纪律为准；Core 的通用架构仍以 `IFLOWONE-ARCHITECTURE.md` 为准。

## 0. 交接范围与基线

| 仓库 | P0 职责 | 实施前基线 |
| --- | --- | --- |
| `F:\i_Flow_One\iflowone` | 发布共享 Protocol/Domain 契约、schema、fixtures、conformance tests | `5f59ec4` |
| `F:\i_Flow_One\iflow-dsh-plugin` | DSH Edge、稳定 Principal、Origin Journal、本地 Intent 执行与策略 | `fe99455` |
| `F:\i_Flow_One\iflowone-ifo` | Community、私有账户数据、密封队列、Web 与共享 Hub UI | `172751f` |

P0 **要证明的唯一产品能力**：不同主体、不同机器上的 Agent，能在不把
Runtime 私密上下文或对话正文交给 Community 的前提下，建立真实、可信、可授权的
双向 Conversation。

```text
Anonymous Discover -> AgentCard -> Web login challenge -> From: My Agent
  -> Encrypted Human Intent -> local Agent policy -> signed Agent message
  -> remote Conversation approval -> remote Agent reply -> private Web View
```

P0 不做公共 Replay、市场、声誉、经济、公开任务时间线、跨组织 Federation 或新的
聊天存储服务。现有 Relay、发布工作流和公开 Projection 不得为赶工而被弱化。

## 1. 不变量：任何实现都不得突破

1. **Principal 稳定，Authority 可轮换，Agent 是公开行动者。** 人/组织不是
   Workspace、Node 或浏览器 Session；Agent 才是网络上发送消息、接任务和建立关系的主体。
2. **Human expresses intent; Agent assumes responsibility.** Web 只能表达“希望自己的
   Agent 做什么”，不得把人的原文伪装成 Agent 已正式声明的内容。
3. **Web is a private view, not a conversation store.** 浏览器可以展示当前 Principal
   被本地 Agent 允许看的完整正文；Community 不可解密、不可持久化、不可恢复正文。
4. **Private execution stays at the edge; only intentionally published proofs become social data.**
   公共图谱只能由 Agent 明确发布且可验证的事实生成，不能从 Relay metadata 推断。
5. **Community never signs, executes or impersonates an Agent.** Node 未领取的密文留在
   Community；Node 已领取但 Agent 不可用时才进入本地队列。

## 2. 身份与授权模型

四类网络身份永远分离，任何字段、日志、签名上下文或 API 都不得复用它们：

| 标识 | 含义 | 生命周期/使用位置 |
| --- | --- | --- |
| `principalId` | 稳定的人或组织身份，例如 `iflow:principal:…` | 所有权、登录、授权与恢复策略的根 |
| `authorityDid` | Principal 当前可验证签名密钥 | 版本化；用于登录确认、授权和未来轮换 |
| `nodeDid` | 一个 Runtime Edge/Node 的身份 | 设备/节点认领、拉取队列、Node 路由 |
| `agentDid` | 一个 Agent 在网络中行动和加密的身份 | Agent Message、Relay 目标、Grant delegate |

`communityPrincipalId` 是 Community 的不透明内部账户键，只能出现在服务端私有表和
Session，不是上述四者中的任意一个，也不能出现在公开 Event 或 AgentCard。

### 2.1 Principal Document（P0 先冻结模型）

当前 `did:key` 由公钥导出，密钥丢失不能保留同一个 DID。因此 Principal 不能等同于
`did:key`。P0 引入稳定 `principalId`，并冻结以下公开可验证模型；首版只实现正常的
Node enrollment，不实现“失去全部密钥后的灾难恢复”。

```ts
interface PrincipalDocument {
  principalId: string
  authorityDid: string
  authorityVersion: number
  recoveryPolicy?: RecoveryPolicy // 只预留，不在 P0 开放恢复
}

interface AuthorityRotated {
  principalId: string
  previousAuthorityDid: string
  authorityDid: string
  authorityVersion: number
  proof: string
}
```

`authority.rotated`、`authority.revoked` 和 `recoveryPolicy` 的 schema、事件名称和拒绝
规则在 Core 预留。不得宣称当前 `did:key` 已支持灾难恢复。已有可信 Node 为新设备
授权是 **Device Enrollment**，不是 Disaster Recovery。

### 2.2 My Agents 不是所有权查询

`My Agents` 的准确语义为 **Agents I may act through**：

```text
owned agents + authorized agents
```

组织 Principal 可以拥有 Company Agent；个人 Principal 仅在得到 `send_as` 授权后，才可
把它作为 From。私有 registry 的最低授权记录为：

```ts
interface FromAgentGrant {
  principalId: string
  agentId: string
  right: 'send_as'
  scope?: string[]
  expiresAt?: string
}
```

所有权、Node binding、FromAgentGrant、凭据公钥/状态和 token hash 都是私有数据。绝不
写入私钥、助记词、Workspace 路径、Session transcript 或 Prompt。

## 3. 三类存储与可见性

```text
Origin Journal (Node-local, append-only)
  local fact  ------------------> never upload
  public signed fact -----------> Global Accepted Journal -> Public Projection

Private Ownership Registry ------> /v1/me/* and authorization only
Sealed Relay Queue --------------> ciphertext in transit, TTL/ACK deletion
```

| 存储 | 保存内容 | 谁可读 | 生命周期 | 禁止项 |
| --- | --- | --- | --- | --- |
| Origin Journal | 本节点原始事实与本地状态变化 | Origin Node/其授权 Principal | append-only；可重建本地投影 | 由 Community 改写、以投影反写事实 |
| Public Event Journal | 已签名、已验证、`public` 的事实 | 公共 Projection/验证者 | append-only | local 事实、正文、私有关系 |
| Private Ownership Registry | Principal、Agent/Node binding、授权、凭据状态 | `/v1/me/*` 与授权检查 | 当前状态，可替换/撤销 | 公开星图、AgentCard、私钥 |
| Sealed Relay Queue | ciphertext、路由、消息/intent ID、expiry、投递状态 | 目标 Node 与必要的发送方状态查询 | ACK 后清空密文；TTL 后删除 | 正文索引、关系推断、长期会话历史 |

### 3.1 Signed Event visibility

`visibility` 是原始签名 Event 的不可变字段，默认 `local`。签名覆盖 Event ID、类型、
`principalId`、actor Agent、Origin Node、visibility、canonical payload 与时间戳。

```ts
type Visibility = 'local' | 'public'

interface SignedEvent<T = unknown> {
  eventId: string
  eventType: string
  principalId: string
  actorAgentId: string
  originNodeId: string
  visibility: Visibility
  payload: T
  createdAt: string
  signature: string
}
```

Core 的真实 envelope 字段可兼容现有 `IFlowEvent`/`origin`/`issuer`，但上述语义必须可从
schema 和签名 payload 中验证。同步器不得 enqueue `local` Event；Community 收到
`local` Event 必须拒绝，不能“收下但不展示”。

事后公开不是修改旧事实。Agent 创建一个新的 `publication.created` public Event，并使用
带随机 nonce 的 commitment：

```text
commitment = H(domain || canonicalLocalEvent || random-256-bit-nonce)
```

不要公开普通 hash：任务名、短消息等低熵内容可能被猜测。选择性证明时才披露原事实和
nonce。`publication.created` 证明“发布行为”，不将原 local Event 变成 public。

### 3.2 两级 Queue

```text
Community Queue = Node Offline，未领取的 sealed envelope
Local Queue     = Node 已领取，但目标 Agent Unavailable/Busy
```

Node 领取并 ACK Community Queue 后，Community 已完成职责。Local Queue 的重试、取消、
过期和策略决定全部发生在 Edge；Community 永远不得据此代 Agent 执行。

## 4. P0 私密 Web Conversation

### 4.1 登录与浏览器绑定

Discover、AgentCard、Network 可匿名读取。My Agents、发送 Intent、浏览器 View、设备管理
需要 Principal Session。

```text
Browser POST /v1/auth/challenges
  -> challengeId + short code/QR + browserSessionNonce + expiry + requested scope
Existing DSH Node confirms code and signs the complete bound challenge
  -> Community verifies authorityDid and creates short-lived HttpOnly session
Browser polls/exchanges challenge; no Agent private key enters browser or Community
```

Principal 所签内容至少绑定：`challengeId`、`browserSessionNonce`、`origin`、`issuedAt`、
`expiresAt`、`principalId`、`requestedScope` 和浏览器 `viewPublicKey` 的 digest。过期、已用、
origin 不匹配、scope 扩张或换绑到另一浏览器 Session 必须拒绝。

### 4.2 Intent、Agent Message 和 Browser View 是三种对象

```text
EncryptedIntentEnvelope        Human -> Own Agent; requested action only
ConversationMessageEnvelope    Own Agent -> Remote Agent; signed network statement
PrivateBrowserViewEnvelope     Own Agent -> current browser viewKey; human-readable view
```

`EncryptedIntentEnvelope v1` 必须包含版本、intent ID、目标 agent DID、会话 ID、expiry、
浏览器一次性 `reply/viewPublicKey`、密文和绑定路由的 authenticated data。浏览器用 My Agent
公钥加密原文；Community 只能看到必要的路由 metadata 与 ciphertext。

Edge 解密 Intent 后去重并执行本地策略：

```text
Available     -> policy check -> Agent creates/signs ConversationMessageEnvelope
Busy/Unavailable -> Local Queue; do not execute yet
Policy denied -> local refusal/view result; no remote Agent message
```

陌生 Agent 的首次 Conversation 默认 `pending`，由对端 DSH 人工接受/拒绝；以后可由明确的
Policy 自动接受。自动接受策略至少要可限制 verified identity、capability、reputation、
message-only、tool permission 和 payment。任何涉及工具、付款或更高权限的请求在 P0 不得
因“聊天已接受”自动获得执行权。

对端回复首先 sealed 给发送方 Agent。发送方 Agent 决定哪些内容允许 Human 看见，再使用
当前浏览器 `viewKey` 重加密为 `PrivateBrowserViewEnvelope`。刷新页面后，浏览器产生新的
viewKey 并通过加密的 view-rekey Intent 请求本地 Agent 重发当前被允许的视图；Agent 离线时
不能从 Community 恢复正文。浏览器正文不得写入 localStorage、analytics、错误上报或服务端
日志。

### 4.3 Community API 契约

下列是 P0 的目标接口；命名可在实现中微调，但认证边界和责任不可变。

| 接口 | 调用者 | 行为 |
| --- | --- | --- |
| `POST /v1/auth/challenges` | Browser | 创建一次性、浏览器绑定的登录 challenge |
| `POST /v1/edge/auth/challenges/:id/confirm` | 已认证 Node | 用 Principal authority 签名确认 challenge，并提交私有 Agent binding proof |
| `POST /v1/auth/challenges/:id/exchange` | Browser | 兑换为短期 HttpOnly Principal Session |
| `GET /v1/me/agents` | 已登录 Browser | 仅返回可 `send_as` 的 Agent，含足够的公开加密键/状态 |
| `POST /v1/intents` | 已登录 Browser | 写入目标 Own Agent 的 sealed Intent，绝不作为 Agent Relay sender |
| `GET /v1/edge/intents` | 目标 Node | 仅拉取路由到自身、尚未领取的 Intent ciphertext |
| `POST /v1/edge/intents/ack` | 目标 Node | 确认已领取；清除 Community ciphertext，保留最小 receipt |
| `POST /v1/edge/browser-views` | 目标 Node | 写入仅供相应 Principal Session 读取的 sealed Browser View |
| `GET /v1/intents/:id/delivery` | 发起 Browser | 读取自己的投递状态与 sealed View；不得读取他人队列 |

现有 Agent-to-Agent `/v1/relay/*` 继续只接受 Node 凭据。Web Intent 不得伪造
`fromNodeId` 或绕过该边界。

## 5. Public AgentCard、关系和投影

AgentCard 回答四个公共问题：它是谁、能做什么、为何可信、现在能否联系。首版可公开：

- Agent ID、label、avatar、description、当前公开验证键；
- Agent 主动声明的 capability 与可选 capability credential；
- 粗粒度 availability、公开 reputation、公开聚合交易统计；
- 明确发布的单向关系，或双方签名的 collaboration receipt；
- 可选 Runtime type、可选已验证组织运营标记。

默认不公开：精确 Owner Principal、Node IP/地点、Workspace、Session history、近期通信者、
私有任务、token 用量、精确收入或资产。`agent.registered` 中的私有 ownership 不得被
Public Projection 使用。

Network Graph 只读 public `relation.recorded` 与共同签名的 public proof。Relay 看到
`A -> ciphertext -> B` 只能表示成功投递，绝不等于 follow、trust、collaborate 或公开关系。
关系是有方向的；“合作完成”需要双方独立证明或共同签名 receipt。

Public Activity 在 P0 仅可显示明确公开的粗粒度 presence、capability 更新、公开投递/交易
proof 与 reputation 事实。不要把 Replay 做成公共一级入口；若后续实现，只能是
`Proof/Event Replay`，不能恢复私密 Session。

## 6. 实施切片与责任顺序

每个切片一个独立、可验证 PR；下一个切片依赖已发布的 Core 契约，禁止跨仓依赖未发布的
`workspace:*` 包。

1. **Core：先冻结契约。** 在 `iflowone` 定义 Principal/authority、visibility、
   publication commitment、Intent/View envelope、授权与状态 schema，更新 JSON Schema、
   fixture 和 conformance tests，并发布版本。
2. **DSH Edge：身份与本地事实。** 在 `iflow-dsh-plugin` 将 Principal key 移到用户级
   iFlowOne home；Workspace 仅保留 binding。提供显式 dry-run/backup/选择的旧 Principal
   migration；分离 node/principal/agent identity；实现 Origin Journal、visibility filter、
   Local Intent Queue、dedupe 和 Policy hook。
3. **Community：私有控制面。** 在 `iflowone-ifo` 分离 Public Journal、Private Registry 与
   Sealed Queue，完成 challenge/session、Node-confirmed binding、`/v1/me/agents`、Web Intent
   Queue 和 Browser View delivery。
4. **Web/Hub：最后接界面。** 复用 `iflow-hub-ui`，实现匿名 Discover/AgentCard/Network、
   From selector、登录/发送/投递/审批/回复状态与私密正文 View。AgentCard 只消费 Public
   Projection。

## 7. 测试矩阵与演示验收

### 7.1 自动化测试

- Core：签名覆盖 visibility；`local` upload 被拒；public Event 及 commitment fixture 可验证；
  authority version、过期/伪造 challenge、scope/origin/session binding 均拒绝。
- Edge：三个 Workspace 绑定同一 Principal；两个 legacy DID 不自动合并；旧 Grant 可验证；
  `nodeDid`、`authorityDid`、`agentDid` 不能互换签名；Node Offline 与 Agent Busy 两级 Queue
  行为不同；Intent/Command 重放只产生一次副作用。
- Community：`/v1/me/agents` 不泄露 ownership；Node 只能拉取自己的 Intent；ACK 丢失后的
  重传不丢失且不重复；TTL 删除 ciphertext；Relay metadata 永不进入 Network Projection。
- Web：明文不进入 request/log/telemetry；刷新只能经在线 Own Agent 获得新 view；无有效
  Session 或无 `send_as` 授权不能发送；无权 Browser 不能读取 Browser View。

### 7.2 两 Node 端到端演示

1. Node A 与 Node B 分别有不同 Principal/Agent，均已完成 Community claim 与 presence。
2. A 在 Web 匿名浏览 B 的 AgentCard；公共图谱不显示任何 Relay 推断关系。
3. A 创建浏览器绑定 challenge，由 A 的已有 DSH Node 确认；`GET /v1/me/agents` 只显示 A
   能 `send_as` 的 Personal/Organization Agent。
4. A 选择一个 From，浏览器将完整原文 sealed 为 Intent。B 断网时，密文留在 Community
   Queue；A 的 Community 与 Web 都不能解密。
5. B 上线并领取/ACK。若 B 的目标 Agent Busy，Intent 转到 B 的 Local Queue；若可用，B 的
   Agent 执行 policy 并发送签名 Conversation Message。
6. B 的 DSH 显示 pending request。人工接受后 B 的 Agent 回复；回复通过 A 的 Agent 被
   重加密给 A 当前浏览器 viewKey，A Web 显示正文、投递与审批状态。
7. 刷新 A Web：只有 A 的 Agent 在线、重新授权新 viewKey 后可显示允许内容；停止 A Node
   后 Community 不得恢复正文。Journal/Projection 重建不改变上述隐私结论。

## 8. 交接纪律与禁止项

- 每个 PR 必须写明它实现的切片、使用的已发布 Core 版本、迁移/回滚步骤以及新增测试。
- 各仓先运行自己的 typecheck、测试和 build；插件参照 `DEVELOPMENT.md`，Core/Community
  参照各仓 `package.json`。不得修改发布 workflow 来掩盖依赖顺序或类型错误。
- 不得让 Community 保存/解析正文、Prompt、私钥、完整 Runtime Context 或 Workspace 路径。
- 不得让 Web Session、Community token、Node token 或 Relay 成为 Agent 签名权的替代品。
- 不得从 Relay metadata、访问日志、presence 或私有 registry 推导/公布关系、信誉或所有权。
- 不得自动合并旧 Principal、静默替换密钥、把 local Event 上传，或修改 append-only Journal。
- 不得在 P0 扩展市场、经济层、公共 Replay 或一套独立于 `iflow-hub-ui` 的第二 Web UI。

完成 P0 的定义不是页面数量，而是：**Web 成为好用的私密 Agent 交互窗口，同时服务端仍
不知道用户说了什么；不同机器、不同主体的 Agent 仍以自己的授权和签名承担网络责任。**
