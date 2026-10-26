# dsh-codex-pilot

把本机 **OpenAI Codex CLI** 接成 [DeepSeek Harness](https://github.com/deepseek-ai) 的原生工具：DSH 里的 agent 可以直接把一整块活派给 Codex，拿到结果、续接会话、甚至往运行中的会话里投消息。

同一套 op 语义有两种形态，按需选一种：

| 形态 | 入口 | 需要什么 |
| --- | --- | --- |
| **DSH 插件**（推荐） | `lib/index.js`，注册 `codex_*` 工具 | 已装 DSH + 本机 `codex` |
| **独立桥** | `standalone/bridge.cjs`，HTTP + 文件信箱 | 只要 Node ≥ 20 |

两者都只是 `codex` CLI 的一层薄封装：不代理模型、不碰凭据，用的是你本机已经登录好的 Codex。

## 安装

```bash
# 从 GitHub 装（未发 npm 时）
dsh plugin --profile web add github:Dobo233/dsh-codex-pilot

# 本地开发
dsh plugin --profile web add E:\path\to\dsh-codex-pilot
```

装完重启 DSH（或让 `patchReload` 生效），工具面板里应出现 `codex_run / codex_resume / codex_queue / codex_probe`。

## 工具

| 工具 | 干什么 | 底层 |
| --- | --- | --- |
| `codex_run` | 开一次性会话跑一整块任务，同步返回输出 | `codex exec [--skip-git-repo-check] -C <cwd> [-s <mode>] [-m <model>] "<prompt>"` |
| `codex_resume` | 续接已有会话 / 最近一个会话 | `codex exec resume <id> "<prompt>"`、`codex exec resume --last` |
| `codex_queue` | 往**正在运行**的会话投一条消息，不打断当前回合 | `codex queue --thread <id> --message <text>` |
| `codex_probe` | 体检：解析到的可执行文件、版本、子命令是否可用 | `codex --version` / `exec --help` / `queue --help` |

`codex_probe` 是排错第一站：`codex_*` 报错时先跑它，能区分「找不到 codex」「版本太老没有 queue」「cwd 不存在」。

## 配置

插件配置（`cordis.patch.yml` 的 config 字段，或 profile 里的条目 config）：

```yaml
codexPath: null        # 显式路径；null = 自动探测（LOCALAPPDATA\OpenAI\Codex\bin\*\codex.exe 按 mtime 取最新，再退 ~/.codex/.sandbox-bin/codex.exe，再退 PATH）
codexHome: null        # CODEX_HOME；null = ~/.codex
defaultCwd: null       # 默认工作目录；null = DSH 进程 cwd
timeoutMs: 600000      # 单次调用超时
maxOutputChars: 20000  # 返回给模型的输出上限，超长保留尾部（Codex 的结论在末尾）
skipGitRepoCheck: true # 是否给 codex exec 加 --skip-git-repo-check
extraEnv: {}           # 追加给子进程的环境变量
```

自动探测是刻意的：Codex 每次升级会换 `bin/<hash>` 目录，写死路径必然失效。

## 独立桥（不用 DSH）

```bash
node standalone/bridge.cjs                 # 默认 http://127.0.0.1:8787
node standalone/bridge.cjs --config my.json
```

- HTTP：`GET /health`、`GET /probe`、`POST /run`、`POST /resume`、`POST /queue`（别名 `POST /codex`、`POST /start`）
- 文件信箱：把请求写成 `mailbox/inbox/<id>.json`，结果落到 `mailbox/results/<id>.json`；坏 JSON 进 `mailbox/quarantine/`
- Windows 上 `.\standalone\ask.ps1 "任务描述"` 是最短路径（桥没起来会自动拉起）

请求体字段：`{ prompt, cwd?, model?, sandbox?, timeoutMs?, sessionId?, last? }`（`/queue` 用 `{ thread, message }`）。

## 安全边界

- 只跑**本机已登录**的 Codex，不读取、不转发、不存储任何 token。
- `codex exec` 有写文件和执行命令的能力 —— 想收紧就传 `sandbox: "read-only"`，或在 `execArgs` 里自己加旗标。
- 桥只绑 `127.0.0.1`，**没有鉴权**：别改成 `0.0.0.0`，别暴露到公网。
- 插件声明 `inject: ["tools"]`，只用 `ctx.tools.register`，不碰文件系统之外的宿主能力。

## 兼容性

- DSH：`0.2.x`（`engines` 未锁死，patch 走 `dsh.bundle` 清单）
- Node：`^22.19.0 || >=24.0.0`
- Codex CLI：`0.163.x` 实测；`queue` 需要较新版本，老版本 `codex_probe` 会明确报 `queue 子命令: 不可用`

## English

`dsh-codex-pilot` exposes the local OpenAI Codex CLI as DSH tools (`codex_run`, `codex_resume`, `codex_queue`, `codex_probe`) plus a standalone loopback bridge (HTTP + file mailbox) for use without DSH. It wraps your already-authenticated `codex` binary — no model proxying, no credential handling. Binds `127.0.0.1` only, no auth: do not expose it.

## License

MIT