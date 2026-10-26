/**
 * dsh-codex-pilot — 把本机 Codex CLI 接成 DSH 原生工具（host 半）。
 *
 * 与 standalone/bridge.cjs（回环 HTTP + 文件信箱）是同一套 op 语义：
 *   run / resume / queue / probe
 * 区别只是从「另起一个端口 + 轮询信箱」变成「注册进 ctx.tools」，
 * 于是 DSH 里的 agent 可以直接调用，不需要外部进程。
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "codex-pilot";
export const inject = ["tools"];

const DEFAULTS = {
  /** 显式指定 codex 可执行文件；null = 自动探测 */
  codexPath: null,
  /** CODEX_HOME；null = ~/.codex */
  codexHome: null,
  /** 默认工作目录；null = DSH 进程 cwd */
  defaultCwd: null,
  timeoutMs: 600000,
  /** 返回给模型的 stdout/stderr 上限（保留尾部，Codex 的结论在末尾） */
  maxOutputChars: 20000,
  skipGitRepoCheck: true,
  extraEnv: {},
};

function pickNewest(dir) {
  try {
    return readdirSync(dir)
      .map((v) => ({ v, t: statSync(join(dir, v)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .map((x) => x.v);
  } catch {
    return [];
  }
}

export function resolveCodexPath(cfg) {
  const cands = [];
  if (cfg.codexPath) cands.push(cfg.codexPath);
  if (process.env.CODEX_CLI_PATH) cands.push(process.env.CODEX_CLI_PATH);
  if (process.env.LOCALAPPDATA) {
    const base = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    for (const v of pickNewest(base)) cands.push(join(base, v, "codex.exe"));
  }
  cands.push(join(homedir(), ".codex", ".sandbox-bin", "codex.exe"));
  for (const c of cands) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {}
  }
  return "codex";
}

function clamp(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return "…[前 " + (text.length - max) + " 字省略]…\n" + text.slice(-max);
}

function runCli(cfg, argv, opts) {
  const cwd = opts.cwd || cfg.defaultCwd || process.cwd();
  const timeoutMs = Number(opts.timeoutMs || cfg.timeoutMs);
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timer = null;

  return new Promise((done) => {
    const finish = (status, extra) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const e = extra || {};
      done({
        status,
        exitCode: typeof e.exitCode === "number" ? e.exitCode : null,
        durationMs: Date.now() - startedAt,
        cwd,
        argv,
        stdout: clamp(stdout, cfg.maxOutputChars),
        stderr: clamp(stderr, cfg.maxOutputChars),
        error: e.error || null,
      });
    };

    let child;
    try {
      child = spawn(cfg.codexPath, argv, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(cfg.codexHome ? { CODEX_HOME: cfg.codexHome } : {}),
          ...cfg.extraEnv,
        },
      });
    } catch (err) {
      return finish("error", { error: "spawn 失败：" + err.message });
    }

    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("error", (err) => finish("error", { error: String(err.message || err) }));
    child.on("close", (code) => {
      if (code === 0) finish("done", { exitCode: 0 });
      else finish("failed", { exitCode: code, error: "exit code " + code });
    });

    const abort = () => {
      try {
        child.kill();
      } catch {}
      finish("cancelled", { error: "已取消" });
    };
    if (opts.signal) {
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish("timeout", { error: "超时 " + timeoutMs + "ms" });
      }, timeoutMs);
    }
  });
}

function render(r) {
  const lines = [
    "[" + r.status + "] exit=" + r.exitCode + "  " + (r.durationMs / 1000).toFixed(1) + "s",
    "cwd: " + r.cwd,
    "argv: codex " + r.argv.map((a) => JSON.stringify(a)).join(" "),
  ];
  if (r.error) lines.push("error: " + r.error);
  if (r.stdout) lines.push("---- stdout ----", r.stdout);
  if (r.stderr) lines.push("---- stderr ----", r.stderr);
  return lines.join("\n");
}

const output = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }],
};

function runArgs(cfg, args) {
  const argv = ["exec"];
  if (cfg.skipGitRepoCheck) argv.push("--skip-git-repo-check");
  argv.push("-C", resolve(args.cwd || cfg.defaultCwd || process.cwd()));
  if (args.sandbox) argv.push("-s", args.sandbox);
  if (args.model) argv.push("-m", args.model);
  argv.push(args.prompt);
  return argv;
}

function resumeArgs(args) {
  // 注意：`codex exec resume` 不接受 --skip-git-repo-check（0.163 实测会报未知参数）
  const argv = ["exec", "resume"];
  if (!args.sessionId && !args.last) throw new Error("resume 需要 sessionId 或 last=true");
  if (args.sessionId) argv.push(args.sessionId);
  else argv.push("--last");
  if (args.prompt) argv.push(args.prompt);
  return argv;
}

function buildTools(cfg) {
  const call = (argv, args, exec) =>
    runCli(cfg, argv, {
      cwd: args.cwd,
      timeoutMs: args.timeoutMs,
      signal: exec && exec.signal,
    }).then(render);

  return [
    defineTool({
      name: "codex_run",
      description:
        "把一块独立任务交给本机 Codex CLI，用一次性的 codex exec 会话同步跑完并取回输出。" +
        "适合「让另一个 agent 干一整块活」，不适合需要你实时介入的长任务。",
      parameters: {
        prompt: { type: "string", required: true, description: "交给 Codex 的完整任务描述" },
        cwd: { type: "string", description: "工作目录；默认用插件配置的 defaultCwd 或 DSH 进程 cwd" },
        model: { type: "string", description: "覆盖模型（透传 -m）" },
        sandbox: {
          type: "string",
          description: "沙箱模式（透传 -s）：read-only / workspace-write / danger-full-access",
        },
        timeoutMs: { type: "integer", description: "超时毫秒，默认 600000" },
      },
      output,
      execute(args, exec) {
        return call(runArgs(cfg, args), args, exec);
      },
    }),

    defineTool({
      name: "codex_resume",
      description:
        "续接一个已有的 Codex 会话：给 sessionId（UUID 或会话名）继续对话，或 last=true 取最近一个会话。" +
        "适合在 codex_run 之后的追问。",
      parameters: {
        prompt: { type: "string", required: true, description: "续接时发送的消息" },
        sessionId: { type: "string", description: "会话 UUID 或会话名" },
        last: { type: "boolean", description: "true = 续接最近一个会话（等价 --last）" },
        cwd: { type: "string", description: "工作目录" },
        timeoutMs: { type: "integer", description: "超时毫秒" },
      },
      output,
      execute(args, exec) {
        return call(resumeArgs(args), args, exec);
      },
    }),

    defineTool({
      name: "codex_queue",
      description:
        "往一个正在运行的 Codex 会话里投递一条消息（codex queue），不打断它当前的回合。" +
        "Claude Code 没有对应能力，这是 Codex 独有的一条通道。",
      parameters: {
        thread: { type: "string", required: true, description: "会话 UUID 或精确的会话名" },
        message: { type: "string", required: true, description: "要投递的消息" },
        timeoutMs: { type: "integer", description: "超时毫秒" },
      },
      output,
      execute(args, exec) {
        return call(
          ["queue", "--thread", args.thread, "--message", args.message],
          args,
          exec,
        );
      },
    }),

    defineTool({
      name: "codex_probe",
      description:
        "体检：报告解析到的 codex 可执行文件、版本，以及 exec / resume / queue 子命令是否可用。" +
        "codex_* 工具报错时先跑它。",
      parameters: {},
      output,
      execute() {
        const v = spawnSyncSafe(cfg, ["--version"]);
        const e = spawnSyncSafe(cfg, ["exec", "--help"]);
        const q = spawnSyncSafe(cfg, ["queue", "--help"]);
        const lines = [
          "codexPath: " + cfg.codexPath,
          "codexHome: " + (cfg.codexHome || join(homedir(), ".codex")),
          "--version: " + (v.version || "(失败) " + (v.error || "")),
          "exec 子命令: " + (e.ok ? "ok" : "不可用 " + (e.error || "")),
          "queue 子命令: " + (q.ok ? "ok" : "不可用（旧版 codex 没有这个子命令）"),
        ];
        return lines.join("\n");

      },
    }),
  ];
}

function spawnSyncSafe(cfg, argv) {
  try {
    const r = spawnSync(cfg.codexPath, argv, {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
      env: { ...process.env, ...(cfg.codexHome ? { CODEX_HOME: cfg.codexHome } : {}) },
    });
    const out = (r.stdout || "") + (r.stderr || "");
    const m = out.match(/\d+\.\d+\.\d+[-\w.]*/);
    return {
      ok: r.status === 0,
      status: r.status,
      body: out,
      version: m ? m[0] : "",
      hasQueue: /--thread/.test(out),
      error: r.error ? String(r.error.message || r.error) : "",
    };
  } catch (e) {
    return { ok: false, body: "", version: "", hasQueue: false, error: String(e.message || e) };
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  cfg.codexPath = resolveCodexPath(cfg);
  for (const tool of buildTools(cfg)) ctx.tools.register(tool);
}