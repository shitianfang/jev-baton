/**
 * One-line installer: `jev-use install [claude|codex|pi]` wires the MCP
 * server (or the pi extension) into whichever harness CLIs are present.
 * Codex additionally receives an automatic PreToolUse Gate and a managed
 * global routing block. Existing Codex files are merged and backed up.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_VERSION } from "./server.js";

/** The harnesses jev-use knows how to wire itself into. */
export type Harness = "claude" | "codex" | "pi";

/** One harness's own config command, exactly as it will be run. */
export interface InstallStep {
  harness: Harness;
  command: string;
  args: string[];
}

export interface CodexRuntime {
  nodePath: string;
  cliPath: string;
}

interface HookHandler {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookHandler[];
  [key: string]: unknown;
}

export interface CodexHooksConfig {
  description?: string;
  hooks: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

export const CODEX_ROUTING_START = "<!-- jev-use:codex-routing:start -->";
export const CODEX_ROUTING_END = "<!-- jev-use:codex-routing:end -->";

const CODEX_ROUTING = `${CODEX_ROUTING_START}
## Jev decision routing

Jev is a fast typed-judgment service. Codex remains responsible for planning,
execution, authorization, writing, and final verification.

Use Jev only for bounded judgments whose valid outputs are known before the
call and whose required facts are already present. Prefer it for yes/no checks,
enumerated choices, pass/fail evaluation, retry/continue/stop decisions,
bounded scoring, and choosing among known next actions. Batch questions about
the same state into one call and send only the minimum necessary facts.

Use Codex directly for code, prose, plans, architecture, requirements,
authorization, complex debugging, open-ended work, missing facts, file reads,
Shell execution, browser operation, and final runtime verification.

Treat every result with \`escalate: true\`, an unreachable backend, malformed
output, or adapter failure as handed back to Codex. For voluntary MCP calls,
Codex performs the judgment itself. For automatic PreToolUse gating, only an
explicit Jev allow may continue; deny, escalation, unreachable, or failure
blocks the current tool attempt. Jev never grants permission or bypasses
Codex native approval and sandbox controls.
${CODEX_ROUTING_END}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJevGateGroup(group: HookGroup): boolean {
  return Array.isArray(group.hooks) && group.hooks.some(
    (handler) =>
      handler.type === "command" &&
      typeof handler.command === "string" &&
      handler.command.includes("hook gate --codex"),
  );
}

/** Build the shell command Codex stores for the portable command hook. */
export function codexHookCommand(
  nodePath: string,
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const quote = (value: string) => `"${value.replaceAll('"', '\\"')}"`;
    return `${quote(nodePath)} ${quote(cliPath)} hook gate --codex`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `${quote(nodePath)} ${quote(cliPath)} hook gate --codex`;
}

/** Merge the Jev gate into hooks.json without disturbing unrelated hooks. */
export function mergeCodexHooks(
  existing: unknown,
  command: string,
): CodexHooksConfig {
  if (existing !== undefined && !isRecord(existing)) {
    throw new Error("Codex hooks.json must contain a JSON object");
  }
  const source = existing === undefined ? {} : existing;
  const rawHooks = isRecord(source.hooks) ? source.hooks : {};
  const rawPreToolUse = rawHooks.PreToolUse;
  const preToolUse = Array.isArray(rawPreToolUse)
    ? rawPreToolUse.filter(isRecord).map((group) => group as HookGroup)
    : [];
  const gate: HookGroup = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command,
        timeout: 30,
        statusMessage: "Jev is reviewing this tool call",
      },
    ],
  };
  return {
    ...source,
    hooks: {
      ...rawHooks,
      PreToolUse: [...preToolUse.filter((group) => !isJevGateGroup(group)), gate],
    },
  } as CodexHooksConfig;
}

/** Add or refresh one managed routing block while preserving user content. */
export function mergeCodexAgents(existing: string): string {
  const start = existing.indexOf(CODEX_ROUTING_START);
  const end = existing.indexOf(CODEX_ROUTING_END);
  let userContent = existing.trimEnd();
  if (start >= 0 && end >= start) {
    userContent = `${existing.slice(0, start)}${existing.slice(end + CODEX_ROUTING_END.length)}`.trimEnd();
  }
  return `${userContent ? `${userContent}\n\n` : ""}${CODEX_ROUTING}\n`;
}

export interface CodexFileInstallOptions extends CodexRuntime {
  codexHome: string;
  platform?: NodeJS.Platform;
}

export interface CodexFileInstallResult {
  hooksPath: string;
  agentsPath: string;
  hooksChanged: boolean;
  agentsChanged: boolean;
}

function writeWithBackup(path: string, content: string): boolean {
  const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (previous === content) return false;
  if (previous !== undefined) copyFileSync(path, `${path}.jev-use.bak`);
  writeFileSync(path, content, "utf8");
  return true;
}

/** Install the user-level Codex hook and routing policy without replacing user files. */
export function installCodexFiles(
  options: CodexFileInstallOptions,
): CodexFileInstallResult {
  mkdirSync(options.codexHome, { recursive: true });
  const hooksPath = join(options.codexHome, "hooks.json");
  const agentsPath = join(options.codexHome, "AGENTS.md");
  const hooksSource = existsSync(hooksPath)
    ? readFileSync(hooksPath, "utf8").trim()
    : "";
  const hooksExisting = hooksSource ? JSON.parse(hooksSource) : undefined;
  const hooks = mergeCodexHooks(
    hooksExisting,
    codexHookCommand(options.nodePath, options.cliPath, options.platform),
  );
  const hooksChanged = writeWithBackup(
    hooksPath,
    `${JSON.stringify(hooks, null, 2)}\n`,
  );
  const agentsExisting = existsSync(agentsPath)
    ? readFileSync(agentsPath, "utf8")
    : "";
  const agentsChanged = writeWithBackup(
    agentsPath,
    mergeCodexAgents(agentsExisting),
  );
  return { hooksPath, agentsPath, hooksChanged, agentsChanged };
}

/** The exact commands run per harness; pinned to this build's version. */
export function installPlan(
  version: string = SERVER_VERSION,
  codexRuntime?: CodexRuntime,
): InstallStep[] {
  const serve = ["npx", "-y", `jev-use@${version}`, "serve"];
  const codexServe = codexRuntime
    ? [codexRuntime.nodePath, codexRuntime.cliPath, "serve"]
    : serve;
  return [
    { harness: "claude", command: "claude", args: ["mcp", "add", "--scope", "user", "jev", "--", ...serve] },
    { harness: "codex", command: "codex", args: ["mcp", "add", "jev", "--", ...codexServe] },
    { harness: "pi", command: "pi", args: ["install", "git:github.com/shitianfang/jev-use"] },
  ];
}

function cliPresent(command: string, shell: boolean): boolean {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore", shell });
  return !probe.error && probe.status !== null;
}

export function shellForHarness(
  harness: Harness,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" && harness !== "codex";
}

/**
 * Run the plan (all harnesses found, or just `target`). Returns the process
 * exit code: 0 when something was installed, 1 when a step failed or nothing
 * was found, 2 when the target name is not a harness.
 */
export function runInstall(
  target?: string,
  codexRuntime: CodexRuntime = {
    nodePath: process.execPath,
    cliPath: resolve(process.argv[1] ?? "dist/cli.js"),
  },
): number {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const plan = installPlan(SERVER_VERSION, codexRuntime).filter(
    (step) => target === undefined || step.harness === target,
  );
  if (plan.length === 0) {
    process.stderr.write(`jev-use install: unknown target "${target}" (claude | codex | pi)\n`);
    return 2;
  }
  let installed = 0;
  let failed = 0;
  for (const step of plan) {
    if (step.harness === "codex") mkdirSync(codexHome, { recursive: true });
    // Codex ships a real .exe on Windows. Running it without a shell keeps
    // paths such as "C:\Program Files\..." as one argv item. Claude and pi
    // may only expose .cmd shims, so retain their legacy shell path.
    const useShell = shellForHarness(step.harness);
    if (!cliPresent(step.command, useShell)) {
      process.stderr.write(`${step.harness}: '${step.command}' CLI not found${target ? "" : ", skipped"}\n`);
      if (target) return 1;
      continue;
    }
    const run = spawnSync(step.command, step.args, {
      stdio: "inherit",
      shell: useShell,
    });
    if (run.status === 0) {
      if (step.harness === "codex") {
        try {
          const files = installCodexFiles({
            codexHome,
            ...codexRuntime,
          });
          process.stderr.write(
            `codex: gate ${files.hooksChanged ? "installed" : "already current"} in ${files.hooksPath}\n` +
              `codex: routing ${files.agentsChanged ? "installed" : "already current"} in ${files.agentsPath}\n`,
          );
        } catch (error) {
          failed++;
          process.stderr.write(
            `codex: MCP installed, but Gate/routing setup failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          continue;
        }
      }
      installed++;
      process.stderr.write(`${step.harness}: installed (${step.command} ${step.args.join(" ")})\n`);
    } else {
      failed++;
      process.stderr.write(`${step.harness}: '${step.command}' exited ${run.status}\n`);
    }
  }
  if (installed === 0 && failed === 0) {
    process.stderr.write("no harness CLI found (claude / codex / pi) — nothing installed\n");
    return 1;
  }
  if (installed > 0) {
    process.stderr.write(
      "next: set TYPESAFE_API_KEY, OPENROUTER_API_KEY, or AI_GATEWAY_API_KEY " +
        "in the environment your harness runs in (JEV_BACKEND=mock for a keyless dry run)\n",
    );
    if (plan.some((step) => step.harness === "codex")) {
      process.stderr.write(
        "codex next: start the Codex CLI, open /hooks there, and trust the Jev PreToolUse hook; " +
          "then restart the desktop app and run `jev-use doctor`.\n",
      );
    }
  }
  return failed > 0 ? 1 : 0;
}
