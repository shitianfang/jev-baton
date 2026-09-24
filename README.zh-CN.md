# jev-use

[English](README.md) | **简体中文**

Claude Code / Codex / [pi](https://github.com/badlogic/pi-mono) 与
[Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
的最佳协作方式:把不需要输出内容的任务交给 Jev——加速任务、减少 token
消耗,更快更好地完成任务。

它让 LLM 与 Jev 真正协作:需要输出内容时,LLM 接管;不需要内容、只要快速执行时,交给
Jev。

## 演示——真实运行,1× 速度

<table>
<tr>
<td width="50%" valign="top"><b>路线查询:Jev 点击,LLM 打字</b>——10 次决策(p50 274 ms)、4 次写入;查错地点被 Jev 拒绝后 LLM 重写<br><img src="assets/collab.gif" alt="OSM 路线查询:Jev 绿色选控件,LLM 蓝色打字输入地点;错误的 1809 公里地理编码被 Jev 拒绝、LLM 修正,最终得到真实的 3.7 公里步行路线" width="100%"></td>
<td width="50%" valign="top"><b>上下文压缩</b>——200 条消息 7 次调用判完,LLM 一段摘要替换丢弃堆;召回 3/3<br><img src="assets/compact.gif" alt="真实转录把上下文窗口填到 94%;Jev 逐条判留/丢,LLM 的摘要段替换灰色块,窗口降到 44%,三题召回全中" width="100%"></td>
</tr>
<tr>
<td width="50%" valign="top"><b>Pong:球速=决策延迟</b>——按常规调用时 20 秒内 Jev 86 次决策,haiku 6 次,gemini 3 次;给两个基线都加上 enum 约束后差距是 3×<br><img src="assets/pong.gif" alt="三条 Pong 通道 1× 回放真实运行:Jev 的球以每步约 224ms 来回穿场,LLM 的球缓慢爬行" width="100%"></td>
<td width="50%" valign="top"><b>把关每条 shell 命令</b>——危险命令约 230 ms 内带理由拒绝,零 LLM token<br><img src="assets/gate.gif" alt="24 条命令的开发会话 1× 实录:危险命令以置信度 1.00 被拒,正常命令放行" width="100%"></td>
</tr>
</table>

每个演示都是可复跑的脚本,在 [bench/examples/](bench/examples);全部数字、方法、方差与告示:[bench/RESULTS.md](bench/RESULTS.md)
· 第三方实测:[docs/evidence.md](docs/evidence.md)。

## 安装

```bash
npx -y jev-use install    # 自动配置 Claude Code / Codex / pi——检测到哪个装哪个
```

只配置 Codex：

```bash
jev-use install codex
```

安装器会在写入前提示确认，并自动完成 MCP、PreToolUse Gate 和全局
`AGENTS.md` 路由规则；它会合并已有配置并为发生变化的文件生成
`.jev-use.bak`。无人值守安装可加 `--yes`。安装完成后，在终端启动 Codex
CLI，并在 CLI 内执行 `/hooks` 审核、信任这条 Hook，然后重启桌面版。
`/hooks` 不是桌面聊天输入框命令。这个独立的安全确认不会被安装器绕过。

在 agent 运行的环境里配一个 key（`JEV_BACKEND=mock` 可无 key 干跑）：

| 供应商 | 环境变量 |
| --- | --- |
| [TypeSafe 直连](https://typesafe.ai/) | `TYPESAFE_API_KEY` |
| [OpenRouter](https://openrouter.ai/typesafe/jev-1.13) | `OPENROUTER_API_KEY` |
| [Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev) | `AI_GATEWAY_API_KEY` |

`npx -y jev-use doctor` 检查链路。被判断的状态会发往你配置的供应商;`JEV_BACKEND=mock`
全程本地。插件形态（含路由技能和 PreToolUse
把关）：[harness/claude-code](harness/claude-code/README.md) ·
[harness/codex](harness/codex/README.md)。

## 作为库使用

`npm i jev-use`——判断路径零运行时依赖：

```js
import { Jev, check, pick, rate } from "jev-use";

const jev = new Jev();

const { answers } = await jev.judge(state, {
  next: pick("Next action?", { merge: "all green", rerun: "looks flaky", hold: "needs attention" }),
  risk: rate("How risky?", ["routine", "worth a look", "incident"]),
  passed: check("Did the run fully succeed?"),
});
// answers.next → { answer: "merge", confidence: 0.93, confidenceFrom: "reported", escalate: false }
```

Jev 拍不了板的判决会带着 `escalate: true`
和类型化原因交还。工具、判决结构、升级契约、CLI：[docs/reference.md](docs/reference.md)。

## 小到能读完

| 文件 | 职责 |
| --- | --- |
| [src/protocol.ts](src/protocol.ts) | 问题（`check`/`pick`/`rate`）、判决、升级原因的类型 |
| [src/dispatch.ts](src/dispatch.ts) | 调用前分路：哪些步骤根本不进 Jev |
| [src/judge.ts](src/judge.ts) | 筛查 → 后端 → 交还不确定的；`gate` |
| [src/jev.ts](src/jev.ts) | 引擎之上的 `Jev` 客户端 |
| [src/redact.ts](src/redact.ts) | 被门控的动作发出前，先抹掉其中的凭据 |
| [src/backends/](src/backends) | TypeSafe、OpenRouter、Vercel、mock 适配器 |
| [src/server.ts](src/server.ts) | 两个 MCP 工具 |
| [src/cli.ts](src/cli.ts) | `install`、`serve`、`hook gate`、`doctor` |
| [skills/jev-use/SKILL.md](skills/jev-use/SKILL.md) | agent 遵循的路由规则 |

## 开发

```console
$ npm run typecheck && npm test    # 单元测试，含各供应商线上格式 fixture
$ npm run smoke                    # 真实 MCP 客户端 ↔ 构建产物 CLI，走 stdio
$ node bench/run.mjs               # 微基准，用你的 key 和网络
```

主体由 Claude Code（AI 辅助）编写。

MIT © [shitianfang](https://github.com/shitianfang)
