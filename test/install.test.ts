import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_ROUTING_END,
  CODEX_ROUTING_START,
  codexHookCommand,
  installCodexFiles,
  installPlan,
  mergeCodexAgents,
  mergeCodexHooks,
  shellForHarness,
} from "../src/install.js";

describe("installPlan", () => {
  it("registers the running Codex adapter instead of the public package", () => {
    const plan = installPlan("9.9.9", {
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      cliPath: "D:\\tools\\jev-use\\dist\\cli.js",
    });
    expect(plan.map((s) => s.harness)).toEqual(["claude", "codex", "pi"]);

    const claude = plan[0];
    expect(claude.command).toBe("claude");
    expect(claude.args).toEqual([
      "mcp", "add", "--scope", "user", "jev", "--",
      "npx", "-y", "jev-use@9.9.9", "serve",
    ]);

    const codex = plan[1];
    expect(codex.args).toEqual([
      "mcp", "add", "jev", "--",
      "C:\\Program Files\\nodejs\\node.exe",
      "D:\\tools\\jev-use\\dist\\cli.js",
      "serve",
    ]);

    const pi = plan[2];
    expect(pi.args).toEqual(["install", "git:github.com/shitianfang/jev-use"]);
  });

  it("does not route Codex through a Windows shell that splits spaced paths", () => {
    expect(shellForHarness("codex", "win32")).toBe(false);
    expect(shellForHarness("claude", "win32")).toBe(true);
    expect(shellForHarness("codex", "linux")).toBe(false);
  });

  it("merges one idempotent Codex gate without removing existing hooks", () => {
    const command = codexHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:\\tools\\jev-use\\dist\\cli.js",
      "win32",
    );
    const existing = {
      description: "existing hooks",
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "check-bash" }],
          },
        ],
      },
    };

    const once = mergeCodexHooks(existing, command);
    const twice = mergeCodexHooks(once, command);

    expect(twice).toEqual(once);
    expect(twice.description).toBe("existing hooks");
    expect(twice.hooks.PreToolUse).toHaveLength(2);
    expect(twice.hooks.PreToolUse[1]).toEqual({
      matcher: "*",
      hooks: [
        {
          type: "command",
          command:
            '"C:\\Program Files\\nodejs\\node.exe" "D:\\tools\\jev-use\\dist\\cli.js" hook gate --codex',
          timeout: 30,
          statusMessage: "Jev is reviewing this tool call",
        },
      ],
    });
  });

  it("adds one managed global routing block and preserves user instructions", () => {
    const original = "# My instructions\n\nKeep this.\n";
    const once = mergeCodexAgents(original);
    const twice = mergeCodexAgents(once);

    expect(twice).toBe(once);
    expect(twice).toContain(original.trim());
    expect(twice.match(new RegExp(CODEX_ROUTING_START, "g"))).toHaveLength(1);
    expect(twice.match(new RegExp(CODEX_ROUTING_END, "g"))).toHaveLength(1);
    expect(twice).toMatch(
      /For automatic PreToolUse gating, only an\s+explicit Jev allow may continue/,
    );
  });

  it("writes merged Codex hook and routing files with recoverable backups", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "jev-use-codex-install-"));
    try {
      writeFileSync(
        join(codexHome, "hooks.json"),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "finish" }] }] } }),
      );
      writeFileSync(join(codexHome, "AGENTS.md"), "# Existing\n");

      const result = installCodexFiles({
        codexHome,
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        cliPath: "D:\\tools\\jev-use\\dist\\cli.js",
        platform: "win32",
      });

      expect(result.hooksPath).toBe(join(codexHome, "hooks.json"));
      expect(result.agentsPath).toBe(join(codexHome, "AGENTS.md"));
      expect(JSON.parse(readFileSync(result.hooksPath, "utf8")).hooks.Stop).toHaveLength(1);
      expect(JSON.parse(readFileSync(result.hooksPath, "utf8")).hooks.PreToolUse).toHaveLength(1);
      expect(readFileSync(result.agentsPath, "utf8")).toContain("# Existing");
      expect(readFileSync(`${result.hooksPath}.jev-use.bak`, "utf8")).toContain("finish");
      expect(readFileSync(`${result.agentsPath}.jev-use.bak`, "utf8")).toBe("# Existing\n");

      installCodexFiles({
        codexHome,
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        cliPath: "D:\\tools\\jev-use\\dist\\cli.js",
        platform: "win32",
      });
      expect(JSON.parse(readFileSync(result.hooksPath, "utf8")).hooks.PreToolUse).toHaveLength(1);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
