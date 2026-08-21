# iFlow P2 委托协议规范（授权书 + 请求信封 + 越权判定 + 吊销/存证边界）

> 基线：DESIGN.md §3（P2 委托层）+ V19 实现（`iflow-id grant` 签发/验证/分级 + 入站 `X-IFlow-Grant`）。
> 目的：把"人 → Agent 授权绑定"做成机器可验证、可吊销、能力可控、跨运行时可移植的
> 授权书协议。本文是**规范草案**，供审阅；落代码前需你将 A/B/C 三点结论确认进 §3。
> 读法与事实以 `iflow-dsh-plugin/rust/src/grant.rs`、`iflow-plugin.js`（`verifyGrantHeader`/`verifyInbound`）为准，
> 本文不改变已有字段含义，只做**可加性的补全**（`scope` 保留为业务语义别名，新增 `capabilities` 承载技术强制）。

---

## 0. 术语

| 词 | 含义 |
|---|---|
| **P0 subject** | 委托关系的两主体之一。`agent`（P1 机器身份，did:key）或 `human`（自然人）。 |
| **签名根（signature root）** | 签署某客体（授权书）的身份凭据形态。根的强度 = 授权书强度上限。 |
| **授权书（grant）** | 一个**自包含、可验证、可吊销**的签名声明："delegate 可在 issuer 授权下触及 capabilities，至 expires_at"。 |
| **delegate（被委托人）** | 实际执行动作的 agent（P1 did）。 |
| **issuer（授托人）** | 授权书的签名主体。P0 上通常是 human；也可能是将下级能力再托付出去的 agent。 |
| **capability 作用域** | 委托真正限定的**技术能力集**（机器强制）；**跨运行时可移植**。 |
| **business scope** | 业务/语义/定价/责任域（人可读）；**不做技术强制**，供定价与责任划分。 |
| **check-at-use** | 吊销不靠"撤销广播"，而在**使用时**查吊销注册表/账本。 |

---

## 1. P0 subject：人（对应异议 A）

### 1.1 人是一等 P0 subject

当前 §3.1 只有一句"我是你的人类"。本规范把 `human` 提升为与 `agent` 同级的一等主体：

```
P0 subject = {
  kind: "agent" | "human",
  did:  did:key,        // agent 用 did:key；human 用"签名根所导出的可寻址标识"
  root: SubjectRoot     // 签名根的形态描述（关键，见 1.2）
}
```

**委托关系 = 一个 issuer（P0 subject）针对一个 delegate（P1 agent）签发授权书。**
授权书的强度**不超过** issuer 签名根的强度（1.2），因此"谁签的"必须显式可验，不能只有一句话。

### 1.2 人的签名根形态与交付

`SubjectRoot` 描述 issuer 是如何签名授权书的。三档，逐档递增；是**接口约定**，不是绑定某一家实现：

| 档 | `kind` | 私钥形态 | 建议授权级别 | 说明 |
|---|---|---|---|---|
| H1 | `agent-custodial` | 私钥由 agent 持有（今天的默认：human 的 did:key 其实由 agent 层保管） | 仅 L0 | 等于"会话级"，不是真的人签名根。session 被盗即 root 被盗 |
| H2 | `webauthn` / `hwkey` | 私钥由用户设备 authenticator 持有（WebAuthn 常驻凭据 / 硬件密钥），生物/PIN 解锁，私钥不出设备 | L1 / L2 | 推荐的**人签名根默认可选项**；签名 = 一次 fresh 断言（challenge-response） |
| H3 | `ca` / `kyc` | 真实身份桥：CA / KYC / 国家 eID 证书链，终止于信任锚 | L3（及法律/责任场景） | L3 需 H3 根，或 H2 根 + `kyc_ref` 关联到可信身份 |

```json
"issuer_root": {
  "kind": "webauthn",
  "attestation": "...",       // 可选：WebAuthn attestation 对象 / 证书链 base64url
  "kyc_ref": "https://idp.example/user/9cf",   // 可选：H3 时才出现
  "key_ref": "kid:webauthn:cred-0x1a"          // 指向具体凭据，便于轮换与吊销
}
```

### 1.3 授权书由谁签发、如何验人签名

- **签发者**：issuer（human）。用其 SubjectRoot 对应的签名根签名自由体 `GrantBody.canonical()`（见 §2）。
- **验证**：`verify_grant_signature` 用 `issuer` 的**公开密钥**验 `canonical` 字节。公开密钥如何获得，取决于根形态：
  - H1：公钥随授权书（did:key 自包含自描述）。
  - H2：公钥=WebAuthn 凭据公钥；验**签名**（断言）+ 校验 `challenge`（见 1.4 防伪）。
  - H3：验**证书链**终止于信任锚（verify 时序：链 + 吊销状态 + 有效期）。
- **增强规则**：`grant.body.level` 与 `issuer_root.kind` 绑定——**H1 根签不出 L2/L3**，H2 到 L2，H3 才 L3。`evaluate` 需把 `issuer_root.kind` 纳入级别门槛（V19 `evaluate` 只比 `level`，本规范增加根强度约束，见 §5 判定第 4.5 步）。

### 1.4 被盗的人 session 能否铸假授权书（防伪边界）

明确回答：**不能铸"新的"授权书；只能复用已签发的那张（且受吊销/TTL 约束）。**

边界规则：
1. **Session token 不是签名根**。被偷的会话 token 只能以"委托人的既有身份"发请求（P1 `signer`），
   但它**没有 issuer 的签名根**，因此**无法**对新的 `GrantBody` 签出合法授权书——`verify_grant_signature` 必拒。
2. **L2/L3 必须 fresh 断言**。授权书签名的瞬间要相对一个 `challenge`（授权书内 `nonce`/`challenge` 字段）。
   被偷的会话无法回应认证器的 challenge，故无法在"事后"补齐一张 L2/L3 授权书。
3. **默认 deny + 短 TTL**（异见 B）：一张已签发的授权书是"delegate 的权利"，session 被偷只是有权**使用**它，
   所以授权书一律**短命**（§4），并**可吊销**（§6）。这正把 A 与 B 钉在一起。
4. **明文声明**：H1 根（agent-custodial）下，代理与被偷会话等价——故 H1 只配 L0，且 L0 授权书短到"几乎不值得偷"。

**结论**：L2/L3 的细节落地前提 = 先定义"人 = 带自己签名根的 P0 subject"。否则层级越高，责任越悬空。

---

## 2. 授权书 JSON 字段

### 2.1 外层

```jsonc
// DelegationGrant（自包含）
{
  "body":      GrantBody,   // 所签名的事实
  "signature": "hex(64B)",  // issuer 用其签名根对 canonical(body) 签名的 Ed25519 签名字节
  "grant_id":  "sha256hex"  // = sha256(canonical(body))；授权书稳定引用（grant_ref）
}
```

### 2.2 授权书体（GrantBody）—— 在原字段上**可加性**扩展

```jsonc
{
  // ── P0 subject（异见 A）────────────────────────────
  "issuer":       "did:key:...",          // P0 subject（human 或 agent）的可寻址标识
  "issuer_kind":  "agent" | "human",      // 新增：issuer 的主体种类
  "issuer_root":  { "kind": "...", ... }, // 新增：签名根形态（§1.2）；决定授权的强度上限

  // ── 授权对象（P1）─────────────────────────────────
  "delegate":     "did:key:...",          // 被授权执行动作的 agent

  // ── 技术作用域（异见 C）：真正的强制边界，跨运行时 ──
  "capabilities": [                       // 新增：声明式能力契约（§3）
    { "id": "iflow.cap:fs.read" },
    { "id": "iflow.cap:fs.write", "limits": { "maxBytes": 1000000 } },
    { "id": "iflow.cap:shell.exec", "limits": { "maxCalls": 5, "maxDurationSec": 300 } }
  ],
  "deny": [ "iflow.cap:subagent.delegate" ],   // 新增：显式拒绝（优先于 allow）

  // ── 业务/定价作用域（异见 C）：语义层，不做技术强制 ──
  "business_scope": [ "quote", "accept small deposit" ],  // 原 scope 语义；保留 scope 为别名

  // ── 预算/时长/级别 ────────────────────────────────
  "budget":        5000,             // 最小单位；None = 无上限（L0/L3 用）
  "expires_at":    2000000000,       // 必填：Unix 秒；禁止"常驻授权"
  "level":         "L1",             // L0..L3（授托级别上限）
  "revocation_grace": 60,            // 新增：吊销传播容忍窗口（秒，§6）
  "renews":        "a70a...",        // 新增：透明续期所接续的上一条 grant_id

  // ── 元数据 ────────────────────────────────────────
  "label":        "daily ops",
  "created_at":   1787325706,
  "nonce":        "challenge-0x1a",  // 新增：fresh challenge，绑定"签发时刻"以抗重放
}
```

**关键不变式**：
- `canonical()` = 对 body 做**递归排序键**的 JSON 序列化（与 V19 `sort_json` 相同）；签名与 `grant_id` 都作用其上。
- `expires_at` **必填**，**禁止无界**；缺省 TTL 由签发侧给出，违者拒绝签发。
- `renews` 指向被续期的旧授权书（透明续期，见 §6.3），不允许静默延长同一 `grant_id` 的寿命。

---

## 3. capability 作用域：声明式能力契约（异见 C）

### 3.1 为什么分两层

委托真正限定的**不是**业务 scope，而是"允许用哪些工具/能力"。`business_scope` 只是人可读的定价/责任域。
于是授权书体内分两层：

| 层 | 字段 | 性质 | 强制方 |
|---|---|---|---|
| **capability 作用域** | `capabilities` + `deny` | 技术强制，**跨运行时可移植** | 运行时 enforcement shim（有则必须强制，否则拒绝） |
| **business scope** | `business_scope` | 语义/定价/预算/责任 | 经济层与责任划分（不参与越权技术判定） |

### 3.2 能力 ID 规则

- 规范：`iflow.cap:<域>.<操作>`，命名空间化，**不是**某运行时的 tool 名。
- 示例（建议初始目录）：`iflow.cap:agent.run`、`iflow.cap:fs.read`、`iflow.cap:fs.write`、
  `iflow.cap:shell.exec`、`iflow.cap:web.fetch`、`iflow.cap:model.invoke`、`iflow.cap:subagent.delegate`。
- 通配：`iflow.cap:fs.*` 覆盖子命名空间；`*` 表示全量。`deny` **优先于** `allow`。
- 默认：授权书**未列**任何能力时，仅授权基线 `iflow.cap:agent.run`（对话/进度）；**不给**任何特权工具。

### 3.3 跨运行时映射（DSH/OpenClaw/ADK/LangGraph）

- **线上契约 = 规范能力 ID + limits**。运行时不把 DSH 的 tool 名写进授权书——授权书只讲规范 ID。
- **每个运行时**在 Enforcement Shim 里把规范 ID 映射到**自己**的工具绑定；映射表可移植但**绑定是运行时特有**。
- **fail-closed 承诺**：运行时若**无法**把某已授权能力 ID 解析/强制出来，必须**拒绝整张授权书**，
  不得静默当作"未授予"。执行/强制允许是运行时特有——但"能强制"是授权书被接受的前提。

### 3.4 映射到 DSH 现有原语（Enforcement Shim）

| 规范能力 | DSH 原语 | 落地方式 |
|---|---|---|
| `iflow.cap:agent.run` | `subagent` 工具 + maxDepth | 允许派生子 agent；`maxDepth` 限制递归深度（`depthLimit`） |
| `iflow.cap:fs.read` / `fs.write` | `tool-fs` + `sandboxPolicy` | 通过 `captureDelegatedPolicyOverrides` 让子会话继承折叠后的 sandbox 策略：只读→`read-only`、写→`workspace-write`；`danger-full-access` **必须显式授予**，默认拒绝 |
| `iflow.cap:shell.exec` | `dsh-shell` | 对应能力为 `shell.exec`；子会话 sandbox 收紧 + 超时（`limits.maxDurationSec`） |
| `iflow.cap:web.fetch` | `dsh-web` | 对应 `web.fetch`；`limits.maxBytes` 约束 |
| `iflow.cap:model.invoke` | 模型调用 | `limits.maxTokens` 约束 |
| 各能力 → **工具可见性** | `subagent` 的 `toolFilter` | 能力 allow 集 → `toolFilter.allow`（允许的工具）；`deny` 集 → `toolFilter.deny`。被过滤工具**从子 prompt 消失且在运行时拒绝**（`tool-subagent` 已实现） |
| **任何时候子会话不得反向征询人** | `approval` 钉死 `'never'` | `captureDelegatedPolicyOverrides` 之后，`appendDelegatedPolicyOverrides` 把 `approval/policy: never, source: delegation` 写入子会话；`'never'` 在 dispatch 前确定性拒绝（fail-closed），**不依赖**父会话是否有 override |

> 语义要点：**"决定"在授权时已经由人做出（grant 的 level）**，所以被委派子会话**不允许**在运行时再问人。
> 这正是把 `approval` 钉成 `never` 的理由；L2/L3 的"人的同意"发生在**签发（或续期、或现场 fresh 断言）**，不在执行时反复问。

---

## 4. 请求信封（`X-IFlow-Grant`）

V19 已存在 `X-IFlow-Grant`。本规范把其**结构**与**绑定**补齐为：

```jsonc
// HTTP 头：X-IFlow-Grant (JSON，单行 base64 或原样 JSON)
{
  "grant": DelegationGrant,       // 完整自包含授权书
  "action": "iflow.cap:fs.write", // 此次请求声称落实的【能力 ID】；不写业务名
  "level":  "L1",                 // 此次动作要求的授托级别（L0..L3）
  "context": {                    // 可选
    "challenge": "...",           // 与授权书体 nonce 关联（L2/L3 fresh 断言用）
    "purpose":   "write result"
  }
}
```

**绑定关系（防"动作与内容不一致"）**：
- P1 `X-IFlow-Signature` 已对请求体签名（`body_sha256`）。授权书里的 `action/level` 必须与本次请求体**语义一致**。
- 判定侧需**关联校验**：一个 `fs.write` 的 body 不得仅凭 `action: agent.run` 蒙混——Shim 要校验"该 body 使用的工具 ∈ 该 action 映射到的能力"。这是一种**语义**关联，落在 enforcement shim（§3.4），授权书协议负责声明 `action`，Shim 负责核对 body 与 `action` 相符。偏离即拒绝（`ACTION_MISMATCH`）。

---

## 5. 越权判定（authorize）

判定是**使用方本地**的纯函数，进而在**强制点**拦截；顺序决定"先验签名还是先查过期"。

```text
authorize(grant, action, required_level, now, registry, spent, cost)
  → Decision { ok, level, reason? }

顺序：
 1. verify_grant_signature  签名字节 vs issuer 公开根          → 败：SIGNATURE_INVALID
    （含：按 issuer_root.kind 验对应根——webauthn 断言 / ca 链 / did:key 验签）
 2. check_grant_id          recompute(sha256(canonical(body))) → 败：GRANT_ID_MISMATCH
 3. nonce/challenge 校验    与 context.challenge 一致（L2/L3） → 败：CHALLENGE_MISMATCH
 4. effective_expiry        now <= min(expires_at, effective_revoke) → 败：EXPIRED / REVOKED
 5. root-strength vs level  issuer_root.kind 允许的上限 >= level → 败：ROOT_TOO_WEAK_FOR_LEVEL
 6. level    grant.level >= required_level                      → 败：LEVEL_TOO_LOW
 7. scope    action ∈ capabilities（deny 优先；前缀/通配匹配）  → 败：OUT_OF_SCOPE
 8. budget   spent + cost <= budget（若无 budget 跳过）         → 败：BUDGET_EXCEEDED
 9. delegate 请求 signer（P1）== grant.delegate 或 == grant.issuer → 败：SIGNER_NOT_DELEGATE
10. revocation  grant ∉ revocation registry（在决策时刻，§6）    → 败：REVOKED（fail-closed）
```

要点：
- **第 4 步**用 `effective_revoke = revoke_time + revocation_grace`（§6.2），把吊销传播时延折进"过期"。
- **第 5 步**是新增：V19 只比 `level`（grant.body.level vs required_level），本规范再把 `issuer_root.kind` 的强度上限纳入，否则 H1 根能签出 L3 的漏洞仍在。
- **第 10 步**：吊销是 fail-closed。使用方**查不到**吊销注册表时，对 `level >= L1` 一律**拒绝**（deny），不放过。
- **第 9 步**与 V19 一致：signer 必须是被委托人（或授托人本人 human-direct）。V19 写的是 `isIssuer || isDelegate`，保持。

---

## 6. 吊销/存证边界（异见 B）

### 6.1 不再"常驻授权"，改"短命 + 透明续期"

- `expires_at` **必填**；发行侧给一个**短 TTL**（建议：L0 默认 24h，L1 默认 7d，L2/L3 按需）。**无"永久授权"**。
- 续期 = 发一张**新授权书**，`renews` 指向旧 `grant_id`；旧授权书可被吊销而新授权书不受影响，反之亦然。
  续期记录透明，进审计。

### 6.2 吊销：check-at-use，而非撤销广播

- **模型改变**：不再指望"撤销广播"能够及时到达所有节点。使用方在**决策时刻**查询吊销注册表。
- **两级注册表**：
  - **Reg-L（本地）**：使用方本地的一份 revoked 列表（`{ grant_id, revoke_time, revoke_root }`）。同步、即时。
  - **Reg-C（社区/锚链）**：追加式账本（merkle root / hash chain），把 `grant_id` 锚进去；使用方持有最新 root，
    可在**有界陈旧窗口**内证明"成员/缺席"。
- **决策语义**（把传播时延折成容忍窗）：
  ```
  effective_revoke = revoke_time + revocation_grace   // escalation_grace 默认 60s
  now <  revoke_time                     → 未生效，允许
  revoke_time <= now <= effective_revoke → 生效中：L0 允许但告警；L>=L1 一律拒绝
  now >  effective_revoke                → 一律拒绝
  ```
- **宽容窗语义**：`revocation_grace` 是给**注册表同步**的容忍（分片/节点还未看到），不是给"多干一会儿"的豁免。
  在此期间任何 L2/L3 动作**强制拒绝**；L0 动作放行但**记审计告警**（语义上此刻处于"已吊销"）。
- **已授权/在途动作**：动作在吊销**之前**已授权且已开始？_放行到完成_（交付担保优先），
  除非使用方支持中止；在途动作的责任划分**跟授权书 level**（§5 责任边界）。**未开始的动作**在宽容窗内即被拒。

### 6.3 存证边界（proof bundle）

授权书本身是**自包含、可验证、可吊销**的单元；`grant_id = sha256(canonical(body))` 使其**无需链也可验**。
链/账本只做**追加锚定**（把 `grant_id` 锚进 merkle root），且是后补可做（hash 稳定），属于 P3 经济层。

一份可呈堂的**证据包**（供 §5 申诉证据链）：
```jsonc
{
  "grant": DelegationGrant,
  "envelope": { "method","path", "body_sha256", "nonce","timestamp", "signature","signer" }, // P1
  "body": "<原始请求体>",
  "decision": { "ok","level","reason" },       // 使用方如何判定（留痕）
  "revocation": { "registry":"Reg-L|Reg-C", "proof":"...", "as_of":"..." },
  "usage": { "spent","cost" }
}
```
- **边界**：P2 **不包含**密钥托管（HSM/托管的远期硬化）、链上结算、钱包。P2 只负责"授权是否在场、有多强、是否已被吊销"。
- 判定的**留痕**：使用方把每条 `authorize` 的决策（含 `reason`）记录进会话日志——"模型可见 ⟺ 可重放"原则下，
  `decision` 属于**审计事实**，必须可重放得出，附进证据包。

---

## 7. 与现有实现 / DESIGN.md §3 的对应关系

- `grant.body.scope`（V19）→ 本文拆成 `capabilities`（技术强制）+ `business_scope`（业务语义）。**保留 `scope` 为 `business_scope` 的过时别名**，兼容既有授权书；新授权书用分层字段。
- `issuer`/`delegate`/`budget`/`expires_at`/`level`/`label`/`created_at`/`signature`/`grant_id`：字面与 V19 一致，不破坏。
- `verifyInbound`/`verifyGrantHeader`（JS，V19）：保留其"signer ∈ {issuer, delegate}"与"缺授权书即 L0 可通过"的语义；本规范在其上加第 5 步（root-strength）与第 10 步（吊销）。
- DESIGN.md §3.5"边界：预算字段已承载但当前作为元数据；链上存证与可吊销列表属后续硬化" —— **本规范就是把这个"后续硬化"落成协议**：预算升级为 `evaluate_with_budget` 的强制，吊销升级为 check-at-use 注册表，存证升级为锚定账本（P3 再接）。

---

## 8. 裁决记录（if-lt × if-dsk 合议，2026-08 定稿）

> 本节把原先的 5 个开放问题改为**结论**。裁决已落入代码：
> `rust/src/grant.rs`（RootStrength / Capability / deny / RevocationRegistry + `evaluate_full`）、
> `rust/src/main.rs`（`grant create|verify|eval|revoke|status`，`--capabilities/--deny/--root/--grace/--ack-*`）、
> `iflow-plugin.js` 与 `src/index.ts`（`verifyGrantHeader` 以 capability ID 校验 action，`grant eval` 走 check-at-use）。

| # | 原问题 | 裁决 |
|---|---|---|
| 1 | H1 是否彻底禁用 L1+ | **H1 严格 L0-only（默认）**。允许显式 `root-ack` 覆盖到 L2，但覆盖**必须**经 **H2+ 签名根**确认（`ack_root` 自身为 H2+、`ack_level` ≤ 其上限、签名可验）。低根（H1/未声明根）**不能自己给自己提权**——无有效 ack 则 `ROOT_TOO_WEAK_FOR_LEVEL` 拒绝。 |
| 2 | 能力 ID 目录与命名规则 | **社区注册表 + 命名空间前缀**：`iflow.cap:<域>.<操作>`，如 `iflow.cap:data.analyze` / `iflow.cap:code.run` / `iflow.cap:fs.read` / `iflow.cap:web.fetch`。新 ID 走**社区治理渐进收编**；**不允许裸自由格式**（防碰撞 / 防伪造能力声明）。`deny` 优先于 allow；`*` / `iflow.cap:<域>.*` 为通配。 |
| 3 | 吊销两级注册表与宽容窗 | **Reg-L 本地优先且同步判定**（`grant eval` 决策时刻加载本地 `revocations.json`）；**Reg-C 异步同步**（链/共识锚定，只追加，同步进 Reg-L，尚未同步的 revoke 不可见，已见者必然生效）。`revocation_grace` **默认 60s**，可配置；宽容窗仅用于注册表同步容忍，非"多干一会儿"豁免（窗内 L≥1 拒绝、L0 放行但记审计）。 |
| 4 | `action` 与 body 语义关联放哪 | **协议层只定义语义**：`action` 必在信封、为规范能力 ID；**强制校验放 Shim**（§3.4 / §4），Shim 核对请求体所用工具 ∈ action 映射的能力，运行时无法对齐则拒（`ACTION_MISMATCH`）。授权书协议只负责声明 `action`，不做参数级校验。 |
| 5 | 与 P3 交接 | **merkle anchor 由结算方（ifo 角色）在完成验证时写**；`grant_id` **作为证据链头部字段进入 bundle**（§6.3 proof bundle 的 `grant.grant_id`），使授权书即使无链也可验（自包含 sha256 稳定引用），链/账本只做追加锚定。 |

### 8.1 与实现的对应

- **root-strength**：`RootStrength{kind}` + `max_level_for_root(kind)`（`webauthn|hwkey`→L2，`ca|kyc`→L3，其余→L0 fail-closed）；`RootAck{ack_level,ack_root,setter,signature}`，`verify_root_ack` 校验 ack_root ≥ H2、ack_level ≤ 上限、签名对 `ack_canonical`（去 signature）验 `setter` did。
- **capability**：`valid_capability_id`（`iflow.cap:` 前缀 + 小写段/数字/-/_，仅允许尾部 `.*` 通配）；`capability_matches` 支持 `*` / `ns.*` / 前缀边界匹配（`fs` 不匹配 `fsx`）。
- **吊销**：`RevocationRegistry{entries:[{grant_id,revoke_time,revoke_root}]}` 持久化于 `<home>/.iflow/revocations.json`；`revocation_verdict`（NotRevoked / Grace / Revoked），`evaluate_full` 决策时刻据此折叠进过期。
- **兼容性**：所有新增字段 `skip_serializing_if`（容量为空 / 根为空 / grace==0），V19 授权书（无这些字段）canonical 字节不变，`grant_id` 与签名仍有效——协议变化严格可加。

### 8.2 跨版本互通测试（v17 → v20 带 grant）

> 目的：验证**旧端（v17，纯 A2A 传输，无授权书能力）**发来的、携带 `X-IFlow-Grant` 的签名请求，被
> **新端（v20，带授权书硬化）**正确接受/拒绝。本机（if-lt）是 v20 端，需重建 `iflow-id.exe` 以生效。
> 以下步骤需在两台真实机器上执行（当前会话无法联网，故只记录步骤）。

**前置**：两端 `iflow_set_token` 同值；`iflow_id` 终端能解析（`shal` 无 `resolveExecutable` 例外）。
v20 端先重建：`cd iflow-dsh-plugin/rust && cargo build --release`，把 `target/release/iflow-id.exe`
复制到 `workspace` 根（覆盖）并重启 `dsh web`。

1. **（v20 端，签发授权书）** 用一个"人"身份的 did 给 v17 的 delegate did 签发一张 L1 授权书：
   ```
   iflow_grant(action=create, delegate=<v17的did>, scope="", level="L1", expiresAt=...,
               capabilities="iflow.cap:agent.run,iflow.cap:fs.read", root="hwkey", label="cross-version")
   ```
   记录 `grantId` 与 `grantJson`。
   - 反向校验 #1：用 `root="agent-custodial"`（H1）+ `level="L1"` 创建应被 CLI **拒绝**
     （`ROOT_TOO_WEAK_FOR_LEVEL`），证明低根不能自我提权。
2. **（确认接受）** v20 端自验：`iflow_grant(action=eval, grant=<grantJson>, actionScope="iflow.cap:fs.read", level="L0")` → OK。
3. **（v17→v20 带 grant 送达）** 用 v17 的身份对 `/a2a` 发 `SendMessage`，请求签名头 `X-IFlow-Signature`
   正常签名，同时附加 `X-IFlow-Grant`（JSON 单行）：`{ "grant": <grantJson>, "action": "iflow.cap:fs.read", "level": "L0" }`。
   - 期望：v20 `verifyGrantHeader` 走 `grant verify` + `grant eval`（check-at-use），`action` 经
     `normalizeAction`/`validCapabilityId` 校验，签名/等级/能力/根强度全过 → 放行，任务 metadata
     记录 `grantId/grantLevel/grantAction/grantCapabilities/grantIssuerRoot/grantRevocationGrace`。
4. **（越权拒绝）** 同一授权书但 `action="iflow.cap:shell.exec"`（未授权）→ 应 `401`（`OUT_OF_SCOPE`）。
   或 `level="L2"` 而授权书为 L1 → `401`（`LEVEL_TOO_LOW`）。
5. **（吊销 check-at-use）** v20 端 `iflow_grant(action=revoke, grantId=<grantId>)`；再 eval（或重发步骤 3）
   → 应拒绝（`REVOKED` / `REVOKED (grace window)`），验证 Reg-L 决策时刻生效。
   - `iflow_grant(action=status, grantId=<grantId>)` 显示 `revoked (within revocation_grace)`，
     60s 后显示 `revoked`。
6. **（H1 收紧回归）** 若对端仍以 v19 的旧授权书（无 `capabilities`/`issuer_root`）请求 L1，v20 应拒绝
   （根默认 H1 → 仅 L0），确认"无新增字段的旧授权书不再能签 L1+"这一收紧行为。

**通过标准**：步骤 3 放行（正确）、步骤 4/5/6 拒绝（正确），且任务 metadata 记录各授权字段；
任何一步出现"应拒却放"或"应放却拒"即失败。
