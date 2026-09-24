# OpenAI Codex CLI

## One-command setup

```bash
jev-use install codex
```

The installer shows the three changes it will make and asks for confirmation:

1. register the running `jev-use` build as the `jev` MCP server;
2. merge an automatic `PreToolUse` Gate into `~/.codex/hooks.json`;
3. add one managed Jev routing block to `~/.codex/AGENTS.md`.

Existing files are preserved and changed files receive a `.jev-use.bak`
backup. Re-running the command updates the same managed entries without
duplicating them. Use `--yes` for a reviewed non-interactive installation.

Set one backend credential in the environment Codex will inherit before it is
restarted, for example `TYPESAFE_API_KEY` with `JEV_BACKEND=typesafe`. The
installer never writes a credential into Codex configuration.

After installation, start the Codex CLI and open `/hooks` there. Review and
trust the exact non-managed hook hash, exit the CLI, and restart the desktop
app. `/hooks` is a CLI interaction, not a desktop-chat slash command. The
installer deliberately does not bypass that independent trust boundary.

## Manual MCP setup

Equivalent by hand:

```bash
codex mcp add jev -- npx -y "jev-use@0.8.0" serve
```

or in `~/.codex/config.toml` (project-scoped: `.codex/config.toml`):

```toml
[mcp_servers.jev]
command = "npx"
args = ["-y", "jev-use@0.8.0", "serve"]
# pass your backend credential through to the server:
env_vars = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY"]
```

Codex discovers `jev_judge` and `jev_gate` via the standard tools/list call.
Since Codex has no plugin skill mechanism, paste the routing table from
[`skills/jev-use/SKILL.md`](../../skills/jev-use/SKILL.md) into your
`AGENTS.md` so the model knows when to pass the baton.

## Manual PreToolUse gate setup

Codex accepts the same hook envelope as Claude Code, but it does not support
Claude's `ask` permission decision. Use the Codex adapter mode in
`~/.codex/hooks.json` (or `<repo>/.codex/hooks.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "npx -y jev-use@0.8.0 hook gate --codex",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Codex requires you to review and trust non-managed hooks via `/hooks`
before they run.

The adapter only stays silent after an explicit Jev `allow`, so Codex's normal
permission flow still decides whether the tool may run. A Jev `deny` blocks the
tool. An `escalate` verdict (including `unreachable`) or an adapter failure also
blocks that attempt with a reason telling Codex to review the action itself or
ask the user before retrying. This is the Codex fallback: uncertainty returns
control to the main agent without treating a Jev outage as permission.

The wildcard Hook silently skips `mcp__jev__jev_judge` and
`mcp__jev__jev_gate` themselves. This prevents a direct Jev judgment from
triggering a second Jev Gate call before it can run; every other matched tool
continues through the normal Gate path.

The adapter reads the same two env vars here — `JEV_GATE_THRESHOLD` and
`JEV_GATE_STATE` (facts the hook event cannot carry, appended to every judged
state) — exported in the environment Codex runs in. See
[the Claude Code notes](../claude-code/README.md#optional-zero-token-pretooluse-gate).
