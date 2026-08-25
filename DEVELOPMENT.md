# iFlow 开发、验证与发布

本指南面向维护 iFlow 本地插件的开发者。完成一次修改后，开发 worktree 验证提交，发布 worktree 运行已打 tag 的版本。

## 目录与职责

| 目录 | 职责 | 是否直接编辑 |
| --- | --- | --- |
| `F:\i_Flow_One\iflow-dsh-plugin` | 唯一源仓和 `dev` 分支 | 是 |
| `deepseek-harness\.local\plugins\iflow-dev` | `dev` 最新提交的 detached worktree | 否 |
| `deepseek-harness\.local\plugins\iflow` | 已确认 tag 的 detached worktree | 否 |
| `deepseek-harness\.iflow` | 身份、撤销记录和计价状态 | 仅由运行时写入 |
| `%USERPROFILE%\.iflowone`（或 `IFLOWONE_HOME`） | 稳定 Principal Registry 与版本化 Authority 密钥 | 仅由身份流程写入 |
| `F:\i_Flow_One\iflowone` | iFlow 核心包源码（已发布到 npm，构建不再需要它） | 是，但那是另一个仓库 |

`.local/` 和 `.iflow/` 由 `deepseek-harness/.git/info/exclude` 排除，不进入公共 Harness 仓库的状态或历史。

## 构建：现在是必需步骤

插件不再是可以直接被加载的单文件。`src/index.ts` 依赖 `iflow-adapter-sdk` 等核心
包，它们是 **devDependencies**（已发布在 npm 上），由 `scripts/build.mjs` 在构建时
打包进 `lib/index.js`。声明成 dev 依赖是因为构建把它们内联了：使用者拿到的是已经
构建好的 `lib/index.js`，运行时不解析任何 iFlow 包，`dsh plugin add github:Neo-Pz/dsh`
这条安装路径保持不变。

要针对核心包里尚未发布的改动开发，用 `npm link`。

代价是：**loader 必须指向 `lib/index.js`，不能再指向 `src/index.ts`**。裸的
`iflow-adapter-sdk` 说明符在 `file://` 直载 TypeScript 的场景下无法解析。

```powershell
# 每次改完 TS 源码都要重新构建
cd F:\i_Flow_One\iflow-dsh-plugin
npm install                    # 首次，或依赖变动后
node scripts\build.mjs
npm test                       # 直接跑构建产物、迁移场景与真实 iflow-id
```

测试分四组：`pure-helpers`（纯函数，含手写 SHA-256 与 node:crypto 对表）、
`edge-integration`（stub 宿主里的完整生命周期）、`command-path`（命令通道，
默认关闭 + 幂等）、`failure-modes` 与 `signing`（架构文档的五项失败测试与原点
签名，都跑在真实磁盘 journal 和真实 Rust 二进制上）。

`.local/patches/*.yml` 里的 `name:` 需要相应改为：

```yaml
- id: iflow
  name: 'file:///F:/i_Flow_One/deepseek-harness/.local/plugins/iflow-dev/lib/index.js'
```

## 开发并验证

1. 在源仓修改 TypeScript 或 Rust 源码，并创建一个可回退的开发提交。

```powershell
cd F:\i_Flow_One\iflow-dsh-plugin
git add -A
git commit -m "Describe the change"
```

2. 将开发 worktree 重置到该提交。此命令会删除 worktree 中未提交的候选修改；先用 `git diff` 审阅并迁回源仓。

```powershell
git -C F:\i_Flow_One\deepseek-harness\.local\plugins\iflow-dev reset --hard dev
```

3. 构建开发 worktree 的插件产物与身份二进制。TypeScript 侧现在必须构建，
   否则 loader 加载的是上一次的 `lib/index.js`。

```powershell
node F:\i_Flow_One\deepseek-harness\.local\plugins\iflow-dev\scripts\build.mjs
cargo build --release --manifest-path F:\i_Flow_One\deepseek-harness\.local\plugins\iflow-dev\rust\Cargo.toml
```

4. 使用开发 patch 启动 Web。`--port 0` 让系统选择可用端口；终端必须保持运行。

```powershell
cd F:\i_Flow_One\deepseek-harness
pnpm dsh web --patch ./.local/patches/iflow-dev.patch.yml --no-open --port 0
```

5. 在浏览器打开日志打印的 `http://127.0.0.1:<port>`，确认设置中的插件列表只有一个 active 的 `iflow` 条目，并调用 `iflow_status`。

6. 验证 iFlow 边缘：跑一段会产生子 agent、工具调用与一次审批的任务，然后确认
   事实真的落进了 Origin Journal，并且投影能读出来。

```powershell
Get-Content F:\i_Flow_One\deepseek-harness\.iflow\edge\origin.ndjson -Tail 20
curl http://127.0.0.1:<port>/iflow/edge/status
curl http://127.0.0.1:<port>/iflow/projection/network
```

7. 把 iFlowOne Web 接到这个边缘上。Web 应用在私有仓库 `iFlowOne-iFO` 里：在
   `<iflowone-ifo>\apps\iflowone-web\.env` 设 `VITE_IFLOW_SOURCE=edge` 与
   `VITE_IFLOW_EDGE_URL=http://127.0.0.1:<port>`，然后 `pnpm -C <iflowone-ifo> dev`，
   打开 `/agents` 与 `/network`。页头的徽标应从 `mock feed` 变成 `live edge`。

## 发布

1. 在源仓确认开发提交后创建版本 tag。

```powershell
cd F:\i_Flow_One\iflow-dsh-plugin
git tag -a v20.0.2 -m "Release v20.0.2"
```

2. 将发布 worktree 切换到该 tag 并构建其身份二进制。

```powershell
git -C F:\i_Flow_One\deepseek-harness\.local\plugins\iflow reset --hard v20.0.2
cargo build --release --manifest-path F:\i_Flow_One\deepseek-harness\.local\plugins\iflow\rust\Cargo.toml
```

3. 使用稳定 patch 启动。它禁用 `iflow_pull`，发布版本只通过 Git tag 更新。

```powershell
cd F:\i_Flow_One\deepseek-harness
pnpm dsh web --patch ./.local/patches/iflow.patch.yml --no-open --port 0
```

## 回滚

选择已有的稳定 tag，重置发布 worktree，重新构建并用稳定 patch 重启。

```powershell
git -C F:\i_Flow_One\deepseek-harness\.local\plugins\iflow reset --hard v20.0.1
cargo build --release --manifest-path F:\i_Flow_One\deepseek-harness\.local\plugins\iflow\rust\Cargo.toml
```

## 注意事项

- 每次运行只选择 `iflow.patch.yml` 或 `iflow-dev.patch.yml` 之一。两个 patch 都注册 `id: iflow`，双载会重复注册工具。
- `iflow_pull` 仅在开发 patch 启用，并写入 detached 开发 worktree。把它产生的 diff 审阅并迁回源仓后再提交；不要把它当作发布机制。
- 插件源码从自己的 worktree 读取。Node/Agent/Runtime 状态写入 Harness 工作区的 `.iflow/`；稳定 Principal Authority 写入用户级 `.iflowone/`。不要删除任一目录，也不要恢复 Harness 根目录的 `iflow-plugin.js` 或 `iflow-id.exe` 副本。旧 `.iflow/principal/` 只能经面板的显式 dry-run、确认与备份流程迁移，禁止手工合并不同 DID。
- Loader 的模块名必须是绝对 `file://` URL，并且必须指向 `lib/index.js`（见上文“构建”）。本机的两个实际 URL 位于 `.local/patches/`；源仓中的 `cordis.patch.example.yml` 仅是模板。
- 入站 A2A 现在**默认失败关闭**：找不到受限的 `remote-a2a` preset 时直接拒绝任务，而不是退回 `standard`（那等于把完整本地工具集交给远端 peer）。要恢复旧行为需显式写 `config.allowUnrestrictedInbound: true`，或用 `config.inboundPreset` 指向另一个受限 preset。
- **事件在原点签名。** 每条 journal 事件带一条 Ed25519 detached 签名，覆盖
  `signableBytes(event)`——信封去掉接收方可添加的 `journalOffset` / `observedAt`，
  再去掉签名本身。密钥不进 Node 进程，由 `iflow-id sign-blob` 处理。没有身份时
  仍然记账，但计入 `journal.unsignedWriteCount` 并在启动时告警，不静默降级。
- **上线是面板上的一次点击，不是改配置。** DSH 设置里的 `iFlow · 弗流` 页（插件的浏览器半边，`src/client/`，挂在 `settings.section` 插槽）负责这件事：先展示本机发现了什么、身份能不能签名，点「上线」时列出会上传/会脱敏/永不离开三类内容，确认后走设备码 Claim——短码显示在本机，人在浏览器里确认，凭据由 Community 直接发给这个节点，全程无人接触密钥。
- **`.iflow/community.json` 优先于 `config.community`。** 配置只是"没人做过决定"时的默认值；一旦有人在这台机器的面板上选过，那个选择说了算。「已停止」和「从未决定」是两个不同的存储状态——否则面板上点了下线，重启后又被配置拉回上线。文件损坏读作「已停止」：读不出自己设置的节点不该靠发布来消解这个疑问。
- **面板的写路由只答本机。** 校验回环地址，或持有本节点 bearer token 的调用者。特别注意它**不复用** `authorized()`——那个函数在未设 token 时对所有人返回 true（对回环读 API 是对的），照搬会导致"没设 token 的节点，局域网里任何人都能替它上线"。
- **安全姿态不进面板。** `acceptCommands`、`routeApprovals`、`hubOrigins` 只在配置文件里改，面板只读显示。给不理解含义的人一个「接受远程命令」的一键开关，比让他去查文档改配置更危险。
- **iflow-id 二进制放在 `<workspace>/.iflow/bin/`，不在包目录里。** 包目录每次升级都会被整个替换（pnpm 把 git 依赖解析成新的内容寻址目录），落在里面的二进制升一次级就没了，于是每次都要手动复制。查找顺序是 `IFLOW_ID_PATH` 环境变量 → `<workspace>/.iflow/bin/` → checkout 里的 `rust/target/release/`（开发者本地 cargo build）；在后两处找到的会被复制到第一处，所以手动复制最多发生一次。找不到时调 `iflow_fetch_identity`，它会立即重试并说明卡在哪一步。
- 命令通道同样默认关闭。`config.acceptCommands: true` 才会让 `POST /iflow/command` 真正执行任何动作；`config.routeApprovals: true` 才会让 Task Room 参与审批（它与 DSH 本地审批**并行竞速**，先答者胜，不会绕过本地授权点）。
- **命令通道无 token 不开门。** 这条唯一的写路由在没有共享 token 时返回 `503`，而不是像读 API 那样"没配 token 就放行"——否则 `acceptCommands: true` 且未设 token 的节点，任何能连到该端口的人都能取消任务（默认只有 loopback，但离 `--host 0.0.0.0` 只差一步）。token 可以用 `config.token` 在启动时给，也可以随时用 `iflow_set_token` 设置/清除：edge 每次请求都读插件的当前值，不是安装那一刻的快照。
- 若浏览器显示拒绝连接，先确认启动终端仍在运行，再访问该次日志打印的新端口；不要复用旧实例的端口。
