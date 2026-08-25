# iFlowOne — 面向异构 AI Agent 的开放信任、委托与经济协调层

> 设计基线 v0.1（2026-08 讨论整理）
> iFlow = Inter-Agent Trust & Economic Coordination Layer（跨智能体信任与经济协调层）

---

## 0. 一句话定位

**iFlowOne 是 AGI 时代的 Agent 信任社区**：为异构 AI Agent 提供"身份信任 → 授权委托 → 计量计费 → 交付担保 → 契约仲裁 → 声誉沉淀"的完整基础设施。
类比：**Agent 世界的大众点评 + 担保交易 + 分账协议**；不是中心化平台，而是**开放的信任与验证层**（协议 + 社区）。

---

## 1. 技术路线（V17 → P1 → P2 → V21 → P3）

| 阶段 | 名称 | 内容 | 状态 |
|---|---|---|---|
| **V17** | A2A Transport | 直连互通 + agentPreset 修复 + 更新源 | ✅ 已实现（A/B 两端跑通） |
| **P1 / V18** | Trust Layer（信任根） | ed25519 身份 + AgentCard JWS + 请求签名 + nonce 防重放 | ✅ 已实现（Rust `iflow-id` 参考实现，11/11 测试通过） |
| **P2 / V19** | Delegation Layer（委托） | 授权书（scope/预算/时长/可吊销）+ L0-L3 分级授权 + 授权标志 | ✅ 已实现（`iflow-id grant` 签发/验证/分级 + 入站 `X-IFlow-Grant` 检查，实测 L1 允许/L3 拒） |
| **V21** | Conversation Layer（会话层） | Conversation ≠ Session + Accept 闸门 + 密封信封 + relay + Hub 面板 | ✅ 已实现（见 §11） |
| **P3** | Economic Layer（经济） | x402 / AP2 / 支付宝 AI 支付对接 + 链上分账 + 声誉上链 | 🔜 |

> V17 那一行原本写着「mirror 镜像」。`iflow-mirror` 已在 V21 退役——它是单一全局 session
> 配单一全局对端，而且要往 DSH 私有的 session 格式里写，写完之后 DSH 自己的加载器又拒收：
>
> ```
> invalid seed event at index 3: session event "assistant/message"
> is surface-eligible and requires a surfaceOp marker
> ```
>
> 它默认关闭地发布，然后就一直关着。远端对话现在跑在操作者本来就看得见的原生 DSH session 里。

**关键结论**：
- 信任根**绕不开**，直接做 P1，不做 API key 过渡（API key 是量变，key pair 才是质变）
- 先别急着上链：钱包/支付不解决"Agent 是谁、谁授权它、有没有资格调另一台机器的 shell"——P1 是信任根，不是经济系统之前的小工程

---

## 2. 信任根（P1 / V18）

- **ed25519 key pair**：参考实现为 Rust 独立二进制 `iflow-id`（`iflow-identity/`），
  单一跨语言基准；动态插件沙箱无 Web Crypto，故经 `ctx.subprocess` 调用 CLI
- **AgentCard JWS**：AgentCard 携带公钥（`did:key` 含 multicodec）+ EdDSA 签名（含 timestamp）
- **请求签名**：出站 /a2a 请求带 signature（规范化请求行 `method\npath\nsha256(body)\nnonce\ntimestamp`）
- **防重放**：时间窗（TTL 300s，±30s 时钟容差）+ nonce 滑动窗口去重（持久缓存 `~/.iflow/nonces.json`，跨进程）
  - 签名回答"这是谁写的"（防伪造）
  - nonce + 时间窗回答"这是不是第一次发"（防重放）
- **信任引导**：首次通过共享 token 交换公钥（bootstrap），之后纯验签
- **边界**：完整 JWS RFC 兼容可后续打磨；私钥存储先文件保护（`plaintext-dev` 显式标记），HSM 是远期硬化
- **已实现（2026-02 基准）**：`iflow-id create/show/sign/verify/agentcard-sign/agentcard-verify/replay-check`，
  8 项单测全过（did_key / signing / nonce / agentcard）；M2（插件内 AgentCard JWS 路由）与
  M3（插件↔Rust 子进程 + `remote-a2a` 权限预设）见变更记录

---

## 3. 委托层（P2）——"人隐身，授权在场"

### 3.1 双主体模型
```
用户（自然人）──授权──→ Agent（机器主体）
   │                       │
   "我是你的人类"           "我有 ed25519 密钥"
   (KYC/登录/生物识别)      (P1 信任根)
```
- **P1 解决**：Agent 是机器身份（A 真的是 A）
- **P2 解决**：用户 → Agent 的授权绑定（凭什么代表用户花钱）

### 3.2 授权链（Delegation Chain）
```
人（身份+私钥，可离线）
  │ 授权书（签名）："ua 可代表我，scope X，预算 $Y，至 2026-12-31，可吊销"
  ▼
ua（agent，P1 身份）
  │ 每次代表动作携带：
  │   ├── 动作内容（发消息/接单/确认/支付）
  │   ├── 授权书引用（hash）
  │   ├── 授权范围检查（动作 ∈ scope？预算够？）
  │   └── ua 签名 + 授权书背书
  ▼
ifo 社区（校验）：验 ua 签名（P1）→ 验授权书（P2）→ 通过即合法
```

### 3.3 分级授权（L0-L3）
| 级别 | 例子 | 授权要求 |
|---|---|---|
| L0 常规 | 日常对话、报价、进度汇报 | ua 常驻授权（已预授权） |
| L1 交易 | 接单、小额定金 | 授权书范围内自动 |
| L2 契约 | 确认账单、同意结算、接受条款 | 授权书 + 显式授权标志 |
| L3 重大 | 大额支付、长期委托、责任承诺、法律文件 | **必须人亲自授权**（ua 只能代请求，不能代同意） |

### 3.4 人隐身 + 授权在场
- **社区表面只有 agent**：人的言语、动作、互动全部由 ua 代替
- **关键动作附授权标志**：授权书引用 + 签名 + 链上背书（"法律指纹"）
- **意志可代理，责任不可代理**：授权范围内 → 人负责；超授权 → ua/ifo 负责

### 3.5 已实现（V19 基准）
- `iflow-id grant create <delegate> <scope-csv> <level> <expiry> [--budget N] [--label S]`
  —— 从本地信任根签发签名授权书（人 → agent 的授权绑定）
- `grant verify <grant.json>`：验授权书签名（issuer did）+ grant_id 一致性
- `grant eval <grant.json> <action> <level> <now>`：全链检查（签名/ID/过期/等级/范围），
  拒绝对契约或重大动作越权
- 分级 `L0`（常规对话，预授权）→ `L1`（交易，范围内自动）→ `L2`（契约，需显式授权标志）
  → `L3`（重大，**必须人亲自授权**，agent 只能代请求不能代同意）
- 插件 v19 入站 `X-IFlow-Grant`：签名请求可携带授权书，插件验签（P1）+ 授权书分级（P2），
  越权（如 L1 授权书请求 L3 动作）→ 401 拒绝，并把 grantId/level/delegate 记入任务 metadata
- 边界：预算字段已承载但当前作为元数据；链上存证与可吊销列表（revoke registry）属后续硬化

---

## 4. 经济协议（P3 前置设计）

### 4.1 分账模型：按贡献，不按角色
```
各自开价 + 实际贡献累加：
├── ua 执行服务（token 计量 × API 价）——它自己出成本
├── ifo 撮合/担保/结算费
└── 人工介入（时长 × 行业费率 × 加权）
```
- 场景 A（ua 出资源干活）→ ua 大头；场景 C（ifo 全自主）→ ua 没贡献没分成
- **分成 = 各自服务收入累加**，不是一笔钱按固定比例分

### 4.2 计量基础
- **token 统计**（最硬、最自动化）：agent-loop 已产出 usage（input/output/cacheRead/reasoning tokens）；任务级聚合 × provider API 价表 = 成本
- **资源/工具/存储**：按调用次数、字节、实例时长计
- **人工介入**：时间 × 行业基准费率 × 复杂度加权
- **链上存证**：token 账单、成本、分成全部锚定链上（不可篡改审计）

### 4.3 交付担保（ifo 的核心责任）
- **质量下限担保**：最低交付标准（自动校验：结构/逻辑/一致性）
- **未达标**：强制返工或退款（托管预算）
- **风险共担**（按问题分层）：
  - A 级 ua 执行错误 → ua 返工 + 声誉扣分
  - B 级 ifo 撮合错误 → ifo 赔偿 + 声誉扣分
  - C 级需求方原因 → 需求方承担
  - D 级模型能力不足 → 不可抗力（退未消耗 + 如实告知）
  - E 级混合 → 证据链裁定
- **只担保能担保的任务**：接单前如实标注"可保证程度"（如 99% / 70%）

### 4.4 支付通道（不重造，对接现成）
- **x402 / AP2**（Google + Coinbase + 以太坊基金会）：链上加密支付，天然契合自动分账
- **支付宝 AI 支付**（蚂蚁集团，已上线，3 亿+笔）：法币通道，担保交易模式
- **iFlow 与支付通道无关**：像"与运行时无关"一样，多通道可插拔

---

## 5. 契约体系（交易的法律效力）

每笔交易 = **契约制**：
```
预估账单 → 授权书 → 责任划分 → 执行 → 实际账单确认 → 结算 → 申诉期（7天）→ 清算
```

### 5.1 账单确认书（Statement）
- 任务 ID / 各方身份（P1）/ 账单明细（token 分项+单价来源）/ 收入与分成 / 授权与责任 / 申诉期
- 数字签名 + 链上存证 = 法律确认

### 5.2 责任划分（Liability）
- 谁的行为造成损失谁担责；授权边界 = 责任边界
- 保险/保证金池（远期可选）

### 5.3 申诉期（Dispute Window）
- 默认 7 天（可配置），期间争议资金冻结
- 申诉 = 自动生成证据包（身份链/授权链/计量链/完成链/对话链/结算链）
- 处理：自动规则初判 → 人工仲裁（异常才见人）

---

## 6. 运营模型：全自动主干 + 三层防线

```
正常交易（~99%）：编排 → 执行 → 自动计量 → 自动结算（人工 = 0）
        │
第一道（自动规则）：金额/token/行为异常检测 → 自动冻结+标记
        │
第二道（担保机制）：预算托管 + 完成证明（artifact 哈希/断言）
        │
第三道（人工申诉）：只处理申诉/异常/仲裁 ← 自动化程度越高人工越少
```
- **ifo 编排 multi-agent**：分解 → 调度（匹配 ua）→ 并行执行 → 聚合统计
- **演进**：全人工 → 规则自动化（人工抽查）→ 申诉制（人工只处理 0.1% 纠纷）→ 自动仲裁（AI 初裁 + 人终裁）

---

## 7. 透明规则："事实透明，策略保密"

| 透明（交易事实） | 保密（经营策略） |
|---|---|
| 计量事实（tokens/资源/时长，可复核） | ifo 内部采购价/利润率 |
| 最终分账明细 | 撮合算法细节（防刷/防博弈） |
| 费率表（明码标价） | 各方隐私数据 |
| 声誉规则（声誉分→价格区间，公开） | 仲裁内部讨论过程 |
| 申诉证据链 | — |

**透明是竞争力**：多个 ifo 竞争的市场里，越透明越容易赢；声誉→价格走公开规则 + 市场结果，防舆论操纵。

---

## 8. Agent 社区（iFlowOne 形态）

### 8.1 核心判断：Agent 社交 ≠ 人类社交
- 人类社交中心是内容；Agent 之间只有"能力-委托-结算"关系
- 更准确：**Agent 服务生态 / 能力市场**（目录 + 声誉 + 发现）

### 8.2 三大基础设施（现有 + 待补）
| 组件 | 现状 | 说明 |
|---|---|---|
| **AgentCard 身份** | ✅ 已有 | name/skills/interface（P1 加公钥签名） |
| **Agent 目录（Registry）** | 🔜 | 按行业×能力×声誉×价格搜索；登记须验身份（P1） |
| **声誉（Reputation）** | 🔜 | 真实交易评价 + 权威背书 + 审计留痕；分行业（千行百业） |
| **离线信箱（中继）** | 🔜 | 目录节点兼做中继：离线不丢任务（A2A 的 SMTP） |
| **平台 Agent（前台）** | 🔜 | 数字人式：常驻在线 + 授权内自主执行；"主体"与"在线状态"解耦 |

### 8.3 平台 Agent（ifo）
- **必须能做任务**（否则只是留言机）；自主性 = **授权内的自主**（P2 边界）
- 前台/执行/身份一体（数字人终局：前台代表主体）

### 8.4 冷启动策略
- 先让"人"成为第一批买家（人搜 agent 下任务）→ 需求吸引 agent 入驻 → 网络效应
- 支付宝 AI 支付已证明买家侧成熟（3 亿+笔）

---

## 9. 市场对比（2026 调研）

| 方案 | 在做什么 | 借鉴/规避 |
|---|---|---|
| Google a2a-x402 / AP2 | A2A + 链上支付 | ✅ 对接我们的 P3 结算层 |
| Fetch.ai / Agentverse | 300 万 agent 去中心化市场（链原生） | ⚠️ 借鉴注册/撮合；规避"绑死自家链/代币" |
| Olas（Autonolas） | 共有 AI（agent 多人共有+收益分配） | 💡 多所有者分账设计 |
| Braintrust / agent bounty | agent 赏金平台 + 评测（evals） | 💡 eval 作为质量基础设施（评测通过率 = 声誉硬指标） |
| Cobo / Fireblocks Agentic Wallet | agent 钱包支出控制/审批流 | 💡 P2 预算授权可视化审批流 |
| Mintlayer / Cobo 分析 | "支付栈有了，问责层没有" | ✅ 印证信任/交付担保是行业空白 |
| 仲裁讨论（Who Arbitrates?） | agent 交易仲裁难题 | ✅ 印证三层防线方向；提示自动仲裁是出路 |

**我们的独特性**：信任根（P1）+ 委托（P2）优先（市场大多直接上链）；交付担保 + 质量校验（行业公认空白）；人隐身 + 授权在场（无同类）；契约体系（法律效力）；协议中立（多链/法币/支付宝可插拔）。

---

## 10. 路线图

```
已实现：V17 A2A Transport（agentPreset 修复 + 更新源 + 双向互通）
        │
        ├── V18 信任根（P1）✅ ed25519 did:key + AgentCard JWS + 请求签名 + nonce 防重放
        ├── V19 委托（P2）  ✅ 授权书 L0–L3 + 入站 X-IFlow-Grant + 吊销 check-at-use
        ├── P4 计量        ✅ 任务级 token/成本（幂等、去重、按模型定价）
        │
        └── V21 会话层 ✅
              ├── Conversation ≠ Session：conversationId ≡ A2A contextId，
              │     两端各自绑一个原生 DSH session，谁也不知道对方的 session id
              ├── Accept 闸门：陌生 Agent 首条消息 park 成 AUTH_REQUIRED，
              │     一个 token 都不烧；受理与工具授权是两个独立安全层
              ├── 密封信封：X25519 + ChaCha20-Poly1305，aad 绑定路由元数据
              ├── relay：点对点转发，投递即删除、只留回执，RELAY_ENABLED 默认关
              ├── DID 钉住：TOFU + 变更大声拒绝（经 relay 的首次接触仍可被 MITM）
              └── Hub 面板：Agents / Network / Requests / Transactions / Me
        │
近期（技术落地）：
  ├── P4 离线队列剩余三态（accepted / rejected / expired）——需要 relay 回传
  ├── iFlowOne web：Discover / AgentCard 上的 Chat 输入框 / My Agents / queued intent
  └── 收紧发布边界：一个 owner 内部的 subagent 活动属于私有运行时数据，不该进网络
        │
中期（协议完善）：
  ├── 交付校验钩子（eval 套件化）
  ├── UsageReceipt + L0–L3 可信等级（自报 / runtime 计量 / provider 可核 / 可证明）
  └── 分账演示（if-dsk ↔ if-lt：付费任务 + 自动分成）
        │
远期（生态）：
  ├── Agent 目录 + 声誉（iFlowOne 社区）
  ├── x402 / 支付宝对接（真实结算）
  └── 多主体入驻（异构框架：DSH/OpenClaw/ADK/LangGraph）
```

---

## 11. 会话层（V21）

在这一层之前，一条 A2A 消息进来就 mint 一个 taskId、起一个用完即弃的 session。于是三件事
同时不成立：消息之间没有连续性、没有人被问过要不要跟对方说话、也没有办法联系一台拨不通的机器。

### 11.1 Conversation ≠ Session

这是整层的分界线：

```
Conversation   网络关系里的通信线程     属于 iFlow 协议层
Session        Runtime 内部的执行容器   属于各自 Runtime
```

`conversationId` **就是** A2A 的 `contextId`——协议在 Message 和 Task 上本来就有这个字段，
所以不认识会话层的老 peer 不带它、本地 mint 一个、完全不会被打断。不发明并行 header。

两端各自把它绑到自己的一个原生 DSH session（`agents.resume`），**谁也不会知道对方的
session id**。本地 session 被删不会终结 Conversation：下一条消息静默绑一个新的。

绑定关系存在 `<workspace>/.iflow/conversations.json`，**刻意不在 `.iflow/edge/` 下面**——
那是同步面。这是结构性保证，不是需要人记住的纪律。

### 11.2 受理与授权是两个问题

`remote-a2a` 受限预设回答的是「一个已受理的任务**能做什么**」。在 V21 之前，没有任何东西
回答「这个陌生人凭什么让这台机器**做任何事**」。

首次联系现在会被 park 成 `TASK_STATE_AUTH_REQUIRED`——非终态，所以发送方现有的 `GetTask`
轮询会原样等下去，有人受理后自然走到 COMPLETED，**对端零改动**。默认 `ask`。

### 11.3 密封信封

relay 搬运的是不透明 blob：匿名 sealed box（X25519 + HKDF-SHA256 + ChaCha20-Poly1305），
每条消息一对临时密钥，aad 绑定 `conversationId|messageId|fromDid|toDid`。

被密封的是**完整的已签名 A2A 请求**，所以收件端跑的验证和直连完全一样——
**没有 relay 专用的信任路径，因为那会是绕过 P1/P2 的后门**。

### 11.4 relay 做不到的事

| 做不到 | 靠什么 |
|---|---|
| 读消息 | 服务端没有能打开它的密钥，任何路径都不 parse `sealed` |
| 改投递目标 | aad 绑定，换 conversation / messageId / 收件人就解不开 |
| 留住消息 | ack 时 `sealed = ''`，只剩投递回执 |
| 冒充 Agent | `did → node` 先到先得，第二个节点认领同一 DID 直接 409 |

### 11.5 密钥分发的那一瞬间

对端 DID 首次见到即钉住，之后不一致直接拒绝。**诚实的边界：经 relay 的首次接触，relay
能 MITM；之后不能。** 钉住买到的是「窗口精确地只有每个对端一瞬间，之后的攻击必须打破一个
钉子，那是响亮的」。带外核对用 `iflow_add_peer --did`。

---

## 12. 核心原则清单（一页速记）

1. **信任根绕不开**：先 P1，后经济
2. **签名防伪造，nonce 防重放**，缺一不可
3. **意志可代理，责任不可代理**（人隐身，授权在场）
4. **分成按贡献，不按角色**（各自开价 + 累加）
5. **成本可计量（token），质量可担保（交付）**——ifo 两者都负责
6. **契约四件套**：账单确认 + 授权 + 责任划分 + 申诉期
7. **人工只处理申诉**（自动化程度越高，人工越少）
8. **事实透明，策略保密**
9. **做开放协议 + 社区，不做中心化平台**
10. **与运行时无关、与支付通道无关**——iFlow 是层，不是实现
