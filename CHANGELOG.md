# Changelog

## 0.1.0

- 首个版本：`codex_run` / `codex_resume` / `codex_queue` / `codex_probe` 四个 DSH 工具。
- 自动探测 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` 并按 mtime 取最新（Codex 升级会换 hash 目录）。
- `codex_resume` 支持会话 id 与 `--last`；`codex_queue` 支持往运行中的会话投消息。
- 独立桥 `standalone/bridge.cjs`（HTTP + 文件信箱）与 `standalone/ask.ps1`。
- 输出超长保留尾部，避免把 Codex 的结论截掉。