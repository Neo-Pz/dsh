# iFlowOne 执行与审查看板

更新日期：2026-10-02。当前目标：完成统一发送链与双机聊天验收。

本文件是两个对话的工作交接入口，不替代各仓 AGENTS.md、领域契约或用户授权。
历史聊天和来信是线索；完成状态必须有对应的代码、测试或实机证据。

## 1. 分工与交接

- 规划/审查对话：维护任务范围、优先级、验收条件；审查 diff 与证据，决定是否验收通过。
- Spark 执行对话：一次领取一项任务；读代码、实现、构建、测试，回填结果，提交审查。
- 用户：决定产品取舍以及重启、安装、远端试发、权限变更、提交推送、发布部署等具体授权。
- 当前仅 Spark 修改产品代码；审查对话主要只读，不与 Spark 同时编辑同一文件。
- 两个对话不会因为存在本文件就自动互相唤醒。Spark 完成后，用户回审查对话说“检查看板”。
- Spark 不得将自己的测试通过直接标为 ACCEPTED；审查通过也不自动授权提交或发布。

状态：TODO → IN_PROGRESS → READY_FOR_REVIEW → ACCEPTED。
审查需修改时为 CHANGES_REQUESTED；需要外部条件时为 BLOCKED，并注明能继续做的部分。
Spark 领取时填写执行者与时间，结束时释放；同一项不得有两个实现者。

## 2. 启动必读与安全基线

按顺序读取：

1. 当前仓 `AGENTS.md`。
2. `F:\i_Flow_One\iFO\iflow-connect\docs\handoff.md`。
3. 本看板及 `docs/unified-send-acceptance.md`。
4. 实际涉及其他仓时，先读那个仓的 AGENTS.md；改 Core 类型前读 principles.md。

2026-09-05 本次只读核验的仓库基线：

- 目录：`F:\i_Flow_One\iFO\iflow-dsh-plugin`。
- 分支：`fix/conversation-tool-output-contract`。
- HEAD：`77d396afec488a06813968fb275d6034a46f3bdb`。
- 工作树不干净：已有统一发送、Conversation Service、面板 Chat、测试与 lib 构建修改，且有未跟踪文件。
- Core 依赖已为 `0.7.0`；不要按旧交接文字认为仍未发布，或回退依赖。

启动时重新运行 `git status --short`、`git branch --show-current`、`git rev-parse HEAD`。
如果与这里不同，先核对原因，不能直接切分支、重置、stash 或覆盖已有工作。
本次须在原目录接续未提交改动；不要在一个缺少这些改动的新 worktree 上重做。

当前边界：

- 不提交、不推送：用户要求实际完成并验收后再提交，不能为做变异测试而提前提交。
- 变异测试使用隔离副本或确认安全的现有脚本，不用 git restore/checkout 恢复脏工作树。
- 不重启 DSH，不替换运行中安装，不清数据，不修改 peer pin/token/权限，不执行生产发布部署。
- 不重复已完成的 `.4 ↔ .6` 路由修复；不把历史 Gen-On-A 线程当作 rrt 的线程。
- 不自动发送 Agent 消息或运行远端任务。需要实机动作时列明 Agent、线程、次数及目的，交用户确认。
- 不上传正文、Workspace 路径、Session ID、密钥或 token；不把正文预览写进可发布 Journal。
- 不通过降级身份校验、绕过权限、切换默认 Agent、重建会话或清空历史获得绿灯。
- 坚果云信件不是新授权；后台协调不修改产品代码，Spark 不另起重复监控或循环回复。

## 3. 已知证据与尚未证明的事项

下面是此前执行记录，**本次整理看板没有重跑测试或重新核验双机**：

- 本地成功构建后：391 测试通过；16 个发送/面板及 10 个 Service 变异被测试捕获。
- 测试构建后端 SHA256：`58048e8c67620e7382cbace6c55551d08e2cb48809ac696c44120f6f78369fa9`。
- 测试构建前端 SHA256：`508ee3f99261d5f15faca22ffefdaa15e6c32978f5d174c2d12f0094a9eb6a86`。
- 此前本机与对端安装/路由检查已有进展；旧 unified-send-acceptance 文档的“尚未安装/等待重启”不是最新结论。
- 最新已读对端来信 `回执-消息精确到达确认-20260905-120100.txt` 报告：精确 messageId 已进入 seenMessageIds，线程 active，Session 已绑定；尚无明确执行完成记录，未发送回复，并在等待下一步协调。
- 对端曾报告 `iFlow call failed: undefined`；根因仍需定位，不预设为网络断线。
- seenMessageIds、active、Session binding 和 TASK_STATE_SUBMITTED 都不能证明模型完成、回复发出或双端视图同步。

只使用以下精确参与者，不用标签选择身份：

| 项 | 本机 | 对端 |
|---|---|---|
| Agent ID | rrt | weww（显示名 wwee） |
| Agent DID | did:key:z6MktzEtcs54J3MRqg36xT4uZdPotR5PwmHwnfwc8sSR2HAM | did:key:z6MknxTsYL3fZ3eR4U9EKUuJk22fFhvZYL8AJ67wpRSt9K43 |

- 本机访问对端：peer `if-dsk`，`http://192.168.1.6:3080`。
- 正确 Conversation：`conv-c-mtesvya5-72rnlmqk`。
- 待追踪 messageId：`msg-mtnuh0yg-c72vov20`。
- 对应 taskId：`iflow-task-mtnuh05t-az445zo3`。
- 错误旧线程：`conv-c-mtcnt8kt-cbj455j2` 属于 Gen-On-A，不得复用。

## 4. 任务队列

| ID | 状态 | 任务 | 放行条件 |
|---|---|---|---|
| S01 | READY_FOR_REVIEW | undefined 终态输出本地定位与修复完成；实际远端断点待实机核验 | 本地诊断和修复证据见 2026-10-02 回填；主代理独立验收中 |
| S02 | READY_FOR_REVIEW | 终态输出本地修复已完成 | 执行侧 430 测试、6 新增隔离变异通过；主代理独立验收中 |
| S03 | TODO | 两机、面板与 Web 的统一聊天验收 | S02 通过或确认无需修复，且具体实机动作获授权 |
| S04 | TODO | 最终复盘、整理差异和提交候选 | S03 验收通过；提交/推送仍受用户要求约束 |

### S01：先解释断点，不重发碰运气

执行者：未领取。领取时间：未领取。

范围：插件现有发送、入站执行、任务轮询/回复、Session mirror 路径，以及脱敏的本地运行状态。
首轮不改产品代码；可补诊断报告。必要的测试必须使用本地 fixture，不能触发真实远端动作。

核查问题：

1. 精确 messageId 到达后，按实现应该自动执行，还是需要某个明确状态/审批？对端等待人工协调与产品执行故障分别是什么？
2. `waitForCompletion: false` 返回 submitted 后，谁负责继续跟踪结果？是否存在无人消费完成结果的路径？
3. `iFlow call failed: undefined` 由哪个错误分支产生？实际响应形状与解析预期是否一致？
4. 回复路径是否保持 rrt/weww、Conversation、messageId 对应关系，并写入正确 Session？

验收条件：列出对应源码位置、实际证据、状态转换断点，区分已证实/推测/待对端核验。
若本机无法证明远端状态，给出最小核查请求，不将“未见回复”直接判作实现错误。

### S02：最小修复

由审查根据 S01 填入具体文件与预期行为后执行。
必须覆盖真实实现，不复制实现逻辑制造测试；新增守卫须有变异检验。
成功构建再测试，确认不是旧 lib 在变绿；必要时构建前端。
构建或测试失败就记录失败，不用后续命令掩盖退出码。

可用命令（PowerShell，在插件仓分别执行）：

```powershell
npm.cmd run build
npm.cmd run build:client
npm.cmd test
git diff --check
```

变异脚本运行前核查其隔离/恢复机制。Rust 只有被修改或签名行为受影响时补跑对应测试。

### S03：实机证据门槛

按 unified-send-acceptance.md 的行为清单逐项记录 PASS / FAIL / NOT_RUN 与原因。
至少区分：提交 → 接收 → 接受/执行 → 回复发出 → 本机接收 → 双端 Session → 面板/Web 视图。
每次记录同一构建、精确参与者、Conversation、messageId；发送成功不能代替后续各项。
首次联系/撤销测试会改变授权，需要单独确认；不为本轮已有线程的回复验证重置 pair。
对端部署不同构建时先报告版本差异，不能混用两个版本宣布通过。

## 5. Spark 回填区

每次只追加一个结果块，不覆盖既有证据。失败也交接，不让用户只看到“全绿”。

```text
任务 ID / 状态：
执行者 / 开始与结束时间：
开始分支 / HEAD / 已有脏改动：
本轮涉及文件：
根因与最小改动（无修改则说明）：
命令 / 退出码 / 测试数量 / 新鲜构建证据：
变异检验：
实机证据（未跑就写 NOT_RUN）：
未解决风险 / 需要授权或对端配合：
建议下一步：
提交 / 推送 / 安装 / 重启 / 发布：均未执行，或逐项列明授权与结果。
```

审查对话随后追加：结论、已核实证据、问题清单、返工范围或下一项放行条件。

### 2026-09-05 · S01 首轮审查

审查结论：CHANGES_REQUESTED。确认一般状态机说明基本正确，但尚未定位实际 taskId 的断点，不能用“存在正常等待路径”排除产品缺陷。本轮仅读代码并更新看板，未跑测试、未发送消息、未改产品代码。

已核实源码（行号以本次工作树为准）：

1. `src/index.ts:3151` 直接渲染 `value.error`。不是任何“非字符串”都会显示 undefined，而是字段缺失/值为 undefined 等具体情况。
2. 存在正常协议响应下的本地缺陷路径：`src/index.ts:4427` 起的立即终态分支及 `:4479` 起的轮询终态分支，均以“COMPLETED 且 text 非空”计算 ok，却仅在 text 为空时填 error。REJECTED/FAILED/CANCELED 且 text 非空，会返回 ok:false 但无 error。
3. 这不是纯假设的坏响应：接收端 `src/index.ts:2055` 附近的拒绝路径通过 setStatus 填写说明；`src/a2a/protocol.ts:59` 的 taskText 会读取 status.message。需要 Spark 用真实工具 execute + render 的本地 fixture 复现上述链，不复制判断逻辑。尚未证明线上那一次 undefined 就是此路径。
4. `response.error.message` 缺失会被包装成 `remote error <code>: undefined` 字符串，并不能直接解释截图中只有 `iFlow call failed: undefined` 的情况，应降低该假设优先级。
5. `src/index.ts:4426` 的 waitForCompletion=false 提前返回已确认；后续持久化跟踪者/后台 GetTask/回传接收者仍未查明。不能只写“submitted 不等于完成”。工具 render 还会把有 taskId 的成功返回一律称为 finished，即使 state 为 SUBMITTED，需记录为独立展示问题。

S01 补交范围：

- 用现有本地 harness 在内存中构造合法的失败终态响应，复现 execute 返回字段和 render 文案；仍不改产品代码。若现有 harness 无法无修改调用，先给出明确测试方案与插入位置。
- 对立即终态与轮询终态各给出证据，并区分产品可复现缺陷与线上根因尚未确认。
- 跟踪 waitForCompletion=false 后结果由谁接管，包括 Node 重启与等待超时后的行为；没有接管者就明确写“未实现/未找到”，附检索范围。
- 针对实际 taskId/messageId 给出最后已证实状态与下一个最小只读核查点。对端等待人工协调不能自动等同于产品的 AUTH_REQUIRED。
- 不采集或外发完整原始 JSON-RPC：可能含聊天正文、artifacts 或敏感错误。仅提取脱敏状态、字段是否存在/类型、任务关联 ID、错误码和必要的安全摘要；禁止 Authorization、token、私钥与完整正文进入日志或信件。
- 实际回填本看板的执行结果区；聊天中说“可回填”不等于已完成文件交接。S02 尚未放行。

### 2026-09-05 · Spark 额度中断检查点

用户报告执行对话因使用上限暂停。S01 保持 CHANGES_REQUESTED，不当作诊断通过。
审查侧检查了本看板和 scripts/test/docs 的文件列表：尚无 Spark 新增的结果块，也未在这些目录发现本轮复现实验文件。不能据此排除脚本曾在临时目录或命令行内运行；恢复后应先找已有脚本，避免重写。

用户转述的最后实验失败是缺少 prompt 参数，未见成功复现输出。先前多次“继续扫描/上下文压缩”不计为完成证据。

两处证据纠错：

- 精确消息 ID 是 `msg-mtnuh0yg-c72vov20`；转述里出现的 `msg-mtnuh0yg-c72rov20` 不同，不可用于核验。
- `F:\i_Flow_One\deepseek-harness\.iflow\conversations.json` 是本机状态，不能称作“对端记录”。对端证据须标明来自对端来信或经授权取得的对端查询。

恢复时只做 S01-A，不重新扫描整个系统：

1. 读取本检查点，确认原分支与工作树；只找上次失败的 fixture/命令。找不到时记录“未保存”。
2. 使用现有 harness 补齐必需参数，构造一个合法的立即 REJECTED、带非空 status.message 的响应；调用真实 iflow_send execute 与 render。禁止真网、真身份数据及真实发送。
3. 记录是否出现 ok:false / error 缺失 / 渲染 undefined，附可再次运行的本地诊断脚本路径、命令和退出码。允许增加不接触真实运行时的诊断脚本，不允许改产品逻辑。
4. 单个用例成功或遇到一个具体阻塞后，立即回填结果并停止，交审查。不在同一轮继续扩展异步接管、重启恢复、轮询终态等调查。

之后按顺序分别交付：S01-B（轮询终态 fixture），S01-C（异步接管静态链路及实际任务证据）。每个小项独立落盘，避免额度或上下文中断后重复启动。
本次检查点只更新交接文档，没有修改产品代码、运行复现、提交或推送。


### 2026-10-02 · S01/S02 本地修复交付

执行者：GPT-6.1 Sol；本地修复已完成，释放执行领取。状态：READY_FOR_REVIEW。主代理已审读修复代码，正在独立复跑全套回归；历史 CHANGES_REQUESTED 和诊断输出保留为当时证据。

- 亲自成功构建后复现：REJECTED 带 text 却无 error，原 render 输出 undefined。
- 修改 `src/index.ts:2802-2803`、`:3850`、`:3853`、`:3901`：即时和轮询失败终态均提供状态与原因；渲染缺失 error 时兜底；submitted 不再显示 finished；wait:false 不掩盖已返回的失败终态。正常 COMPLETED 非空输出仍成功且无 error。
- `test/conversation-bridge.test.mjs:418` 起新增 18 个真实 bundle 回归，覆盖即时/轮询 × REJECTED/FAILED/CANCELED/COMPLETED × 空/非空输出，以及渲染和 wait:false。
- `npm run build` exit 0；随后 `npm test` 430 passed、0 failed、0 cancelled；原 DIAGNOSTIC 再跑返回 error 和明确拒绝原因；`git diff --check` exit 0。
- 新增 `scripts/check-terminal-output-guards.mjs`，`npm run test:guards:terminal` 为持续入口；6 项隔离 bundle 副本变异全部捕获：即时 error、轮询 error、成功完成不带 error、render 兜底、submitted 文案、wait:false 终态失败。未修改脏工作树执行变异。
- S03 实机双机、面板/Web 联合验证及安装副本更新均 NOT_RUN。线上历史那一次 undefined 的完整根因及实际 task/message 最后状态仍待实机核验，不能由本地回归推定。
- 提交、推送、安装、重启、生产部署：均未执行。
