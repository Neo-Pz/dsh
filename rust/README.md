# iflow-id — iFlow 信任根 (P1 / M1)

iFlow 协议三层的信任根参考实现（Rust，单一跨语言基准实现）。
与运行时无关：任何 DSH 插件、任何语言写的 agent 运行时，只要能调用这个 CLI
（或移植同一套算法），就能产生/校验 iFlow 信任信封。

## 零链设计

- 信任根 = 本地 Ed25519 密钥对，无链、无钱包、无 gas。
- 身份 = W3C `did:key`（Ed25519 multicodec `0xed 0x01`，base58btc）。
- 秘密永不离开本机；P1 存储为 `~/.iflow/identity.json`（OS 文件权限保护，
  storage 字段显式标记 `plaintext-dev`，不允许静默升级为“安全”）。
- P3 的经济层（链地址、x402、担保交易）通过独立的 EconomicAttachment 组合
  在身份之上，**绝不修改** `AgentIdentity` 结构。

## 构建与测试

```bash
cd iflow-identity
cargo build --release
cargo test          # 8 tests: did_key / signing / nonce / agentcard
```

> 注意：本机沙箱会阻止 schannel 读取 Windows 证书库，`cargo build` 需要
> 完整文件访问权限才能联网拉取 crates（Node/git 用 OpenSSL 自带 CA 不受影响）。

## CLI 用法

```
iflow-id create [label]           生成并持久化 did:key 身份
iflow-id show                     显示公开身份（绝不显示密钥）
iflow-id sign <method> <path> <body>    签发请求信封（JSON 输出）
iflow-id verify <envelope.json>   校验请求信封
iflow-id agentcard-sign <card.json>     为 AgentCard 签名（JWS）
iflow-id agentcard-verify <signed.json> 校验签名 AgentCard
iflow-id replay-check <nonce> <timestamp>  重放窗口检查（持久 nonce 缓存）

授权书（P2 委托）：
iflow-id grant create <delegate> <scope> <level> <expiry-ts>
      [--budget N] [--label S] [--capabilities CSV] [--deny CSV]
      [--root KIND] [--issuer-kind S] [--nonce S] [--renews GRANT_ID]
      [--ack-setter DID] [--ack-level LVL] [--ack-root KIND] [--ack-sig HEX]
  签发授权书；能力 ID 必须命名空间前缀（iflow.cap:<域>.<操作>），root 强度封顶等级
iflow-id grant verify <grant.json>  校验签名 + grant_id
iflow-id grant eval <grant.json> <cap-action> <level> <now>  [--spent F] [--cost F]
  全链判定：签名/ID/过期/root-strength/等级/能力域/预算/check-at-use 吊销
iflow-id grant revoke <grant_id> [--root DID]   记录吊销（Reg-L）
iflow-id grant status <grant_id>               显示本地吊销判定
```

## 信任信封（SignedRequest）

签名字符串为规范化请求行：

```
method\npath\nsha256(body)\nnonce\ntimestamp
```

- **谁写的**：Ed25519 签名对 signer did 校验（`did.verify`，verify_strict）。
- **是不是第一次**：nonce + 300s TTL 滑动窗口，持久缓存 `~/.iflow/nonces.json`，
  跨进程防重放。STALE/FUTURE 各留 30s 时钟容差。
- 验签通过 ≠ 授权：授权是 P2 委托（L0–L3）与 P3 经济层的事，
  `verify` 只回答“这条消息确实是这个 did 写的、且不是重放”。

## AgentCard JWS

`agentcard-sign` 对规范化（key 排序）AgentCard JSON 做 JWS（EdDSA, flattened）：
`protected.payload.signature`，`kid` = signer did，header 带 `iat`。
`agentcard-verify` 还原并严格校验。能力列表可被第三方验证“确实是发布者发出的”。

## 安全边界（DESIGN.md §2）

| 层 | 问题 | 实现 |
|---|---|---|
| 身份 | 我是谁 | did:key（本仓库） |
| 认证 | 你刚才说的事是你说的吗 | 请求签名 + nonce/TTL |
| 授权 | 你能做什么 | P2 委托（未实现，本仓库不含） |
| 经济 | 凭什么可信/可结算 | P3（未实现，本仓库不含） |

## 与 DSH 插件的对接（M2/M3 计划）

- 插件通过 `ctx.subprocess` 调用 `iflow-id`（沙箱无 Web Crypto）。
- M2：`/.well-known/agent-card.json` 改由 `agentcard-sign` 输出。
- M3：`remote-a2a` 权限预设：入站先 `verify` 信封 + `replay-check`，
  通过才路由进 agent 会话。
