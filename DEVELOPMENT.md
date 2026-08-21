# iFlow 开发、验证与发布

本指南面向维护 iFlow 本地插件的开发者。完成一次修改后，开发 worktree 验证提交，发布 worktree 运行已打 tag 的版本。

## 目录与职责

| 目录 | 职责 | 是否直接编辑 |
| --- | --- | --- |
| `F:\i_Flow_One\iflow-dsh-plugin` | 唯一源仓和 `dev` 分支 | 是 |
| `deepseek-harness\.local\plugins\iflow-dev` | `dev` 最新提交的 detached worktree | 否 |
| `deepseek-harness\.local\plugins\iflow` | 已确认 tag 的 detached worktree | 否 |
| `deepseek-harness\.iflow` | 身份、撤销记录和计价状态 | 仅由运行时写入 |

`.local/` 和 `.iflow/` 由 `deepseek-harness/.git/info/exclude` 排除，不进入公共 Harness 仓库的状态或历史。

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

3. 构建开发 worktree 的身份二进制。即使只改了 TypeScript，重复构建也是安全的。

```powershell
cargo build --release --manifest-path F:\i_Flow_One\deepseek-harness\.local\plugins\iflow-dev\rust\Cargo.toml
```

4. 使用开发 patch 启动 Web。`--port 0` 让系统选择可用端口；终端必须保持运行。

```powershell
cd F:\i_Flow_One\deepseek-harness
pnpm dsh web --patch ./.local/patches/iflow-dev.patch.yml --no-open --port 0
```

5. 在浏览器打开日志打印的 `http://127.0.0.1:<port>`，确认设置中的插件列表只有一个 active 的 `iflow` 条目，并调用 `iflow_status`。

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
- 插件源码从自己的 worktree 读取，身份状态仍写入 Harness 工作区的 `.iflow/`。不要删除 `.iflow/`，也不要恢复 Harness 根目录的 `iflow-plugin.js` 或 `iflow-id.exe` 副本。
- Loader 的模块名必须是绝对 `file://` URL。本机的两个实际 URL 位于 `.local/patches/`；源仓中的 `cordis.patch.example.yml` 仅是模板。
- 若浏览器显示拒绝连接，先确认启动终端仍在运行，再访问该次日志打印的新端口；不要复用旧实例的端口。
