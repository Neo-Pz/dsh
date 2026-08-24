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

密封信封（供 relay 转发用）：
iflow-id seal <recipient-did> <plaintext-file> <out-file> [aad]
  只有该 did 的持有者能打开；[aad] 绑定路由元数据
iflow-id open <sealed-file> <out-file> [aad]
  打开寄给本机身份的信封；不是给本机的、被篡改的、或 aad 对不上的一律失败退出

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

## 密封信封（relay 只搬运，不阅读）

iFlow 的 relay 是点对点转发层：路由、在对方离线时排队、投递后删除。它唯一不能是的，
就是「全网对话都可读」的地方——对运营者可读不行，对以后翻备份的人可读也不行。
所以它搬运的是一个不透明的 blob，而这个 blob 由 `seal` 产生。

构造是匿名 sealed box（libsodium `crypto_box_seal` 的形状）：

```
每条消息一对临时 X25519 密钥
shared  = X25519(临时私钥, 收件人公钥)
key     = HKDF-SHA256(shared, salt = 临时公钥 || 收件人公钥, info = "iflow-envelope-v1")
payload = ChaCha20-Poly1305(key, nonce = 0, 明文, aad = 路由元数据)
sealed  = "v1" || 临时公钥 || payload
```

几处刻意的取舍：

- **nonce 恒为 0 是正确的，不是偷懒**。密钥来自一对只用一次的临时密钥，
  (key, nonce) 组合不可能重复；再带一个随机 nonce 只是多几个字节和多一处可错的地方。
- **匿名，尽管我们知道发件人是谁**。加密只负责保密；「这是谁发的」由信封上那条
  独立的 Ed25519 签名回答（P1 层，`signing.rs`）。两个原语各做一件事，
  比一个原语两件事都做不好要强——而且收件人验证发件人的规则，
  在 relay 和直连 A2A 两条路上完全一样。
- **aad 绑定路由元数据**。relay 读不了消息，但如果不绑定，它仍然可以把一段密文
  当作另一条消息重新投递。绑定之后，换了 conversation / message id / 收件人就解不开。
- **一把密钥两种用途**。X25519 密钥由既有的 Ed25519 身份派生，和 libsodium 的
  `crypto_sign_ed25519_pk_to_curve25519` 同一手法。这是有记录的取舍而不是疏忽：
  它意味着对端只要有你的 `did:key` 就能加密，不需要再发布、轮换、搞错第二把密钥。
  以后想在 AgentCard 里放独立加密密钥也可以，线上格式没有挡住这条路。

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
