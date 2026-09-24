/**
 * The state the PreToolUse hook judges. The hook event carries only the cwd
 * and the permission mode, so `JEV_GATE_STATE` is the one way a user can hand
 * Jev a fact that changes the answer — and an unset variable must leave the
 * state byte-identical to what the hook sent before it existed.
 */

import { describe, expect, it } from "vitest";
import type { BackendRequest, BackendResponse, JevBackend } from "../src/backends/types.js";
import {
  effectiveThresholds,
  gateState,
  HELP,
  hookDecisionOutput,
  hookFailureOutput,
  shouldBypassHookGate,
} from "../src/cli.js";
import { judge } from "../src/judge.js";
import {
  ESTIMATED_CONFIDENCE_THRESHOLD,
  REPORTED_CONFIDENCE_THRESHOLD,
} from "../src/protocol.js";

const INSTRUCTION =
  "The agent proposes the tool call below. Judge only whether it is safe to run without human review.";

const event = { cwd: "/srv/app", permission_mode: "acceptEdits" };

describe("gateState", () => {
  it("sends the event's own facts and the judging instruction, nothing else", () => {
    expect(gateState(event, undefined)).toBe(
      [
        "An autonomous coding agent is working in: /srv/app",
        "Permission mode: acceptEdits",
        INSTRUCTION,
      ].join("\n"),
    );
  });

  it("appends JEV_GATE_STATE as context, ahead of the instruction", () => {
    expect(gateState(event, "production credentials exist in the environment")).toBe(
      [
        "An autonomous coding agent is working in: /srv/app",
        "Permission mode: acceptEdits",
        "production credentials exist in the environment",
        INSTRUCTION,
      ].join("\n"),
    );
  });

  it("adds no line at all when the variable is unset, empty or blank", () => {
    const bare = gateState(event, undefined);
    expect(gateState(event, "")).toBe(bare);
    expect(gateState(event, "   \n ")).toBe(bare);
    expect(bare.split("\n")).toHaveLength(3);
  });

  it("keeps a multi-line JEV_GATE_STATE as written, trimmed at the edges", () => {
    const state = gateState(event, "\nline one\nline two\n");
    expect(state.split("\n")).toEqual([
      "An autonomous coding agent is working in: /srv/app",
      "Permission mode: acceptEdits",
      "line one",
      "line two",
      INSTRUCTION,
    ]);
  });

  it("names what a hook event left out instead of printing undefined", () => {
    expect(gateState({})).toBe(
      [
        "An autonomous coding agent is working in: unknown",
        "Permission mode: default",
        INSTRUCTION,
      ].join("\n"),
    );
  });
});

describe("Codex hook decisions", () => {
  it("bypasses the automatic gate for Jev's own MCP tools only", () => {
    expect(shouldBypassHookGate({ tool_name: "mcp__jev__jev_judge" }, "codex")).toBe(true);
    expect(shouldBypassHookGate({ tool_name: "mcp__jev__jev_gate" }, "codex")).toBe(true);
    expect(shouldBypassHookGate({ tool_name: "mcp__filesystem__read_file" }, "codex")).toBe(false);
    expect(shouldBypassHookGate({ tool_name: "mcp__jev__future_tool" }, "codex")).toBe(false);
    expect(shouldBypassHookGate({ tool_name: "mcp__jev__jev_judge" }, "claude")).toBe(false);
  });

  it("keeps an explicit allow silent so Codex's normal permission flow decides", () => {
    expect(
      hookDecisionOutput(
        { decision: "allow", confidence: 0.98 },
        "codex",
      ),
    ).toBeUndefined();
  });

  it("maps an escalation to deny because Codex does not support ask", () => {
    expect(
      hookDecisionOutput(
        { decision: "escalate", confidence: 0, reason: "unreachable" },
        "codex",
      ),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Jev gate: could not decide safely (unreachable). Codex must review the action or ask the user before retrying.",
      },
    });
  });

  it("keeps Claude's existing escalation-to-ask behavior", () => {
    expect(
      hookDecisionOutput(
        { decision: "escalate", confidence: 0.3, reason: "unsure" },
        "claude",
      )?.hookSpecificOutput.permissionDecision,
    ).toBe("ask");
  });

  it("turns Codex adapter failures into a blocking decision", () => {
    expect(hookFailureOutput("backend initialization failed", "codex")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Jev gate failed before it could decide (backend initialization failed). Codex must review the action or ask the user before retrying.",
      },
    });
    expect(hookFailureOutput("backend initialization failed", "claude")).toBeUndefined();
  });
});

/**
 * The escalation thresholds nobody should have to look up: `doctor` reports
 * both, and the help text states no number at all. They belong to the
 * confidence's SOURCE, not to the backend — a single Vercel response can carry
 * a reported head for its choice answers and none for its boolean ones — so
 * the numbers must not be reachable through a backend at all.
 */
describe("effectiveThresholds", () => {
  it("reports one number per confidence source, for every backend alike", () => {
    const expected = {
      reported: REPORTED_CONFIDENCE_THRESHOLD,
      estimated: ESTIMATED_CONFIDENCE_THRESHOLD,
      source: "jev-use defaults, by confidence source",
    };
    expect(effectiveThresholds()).toEqual(expected);
    // No backend can move them: the two sources are the only dimension left.
    expect(REPORTED_CONFIDENCE_THRESHOLD).toBeGreaterThan(ESTIMATED_CONFIDENCE_THRESHOLD);
  });

  it("an explicit threshold wins for both sources, and says so", () => {
    expect(effectiveThresholds(0.9)).toEqual({
      reported: 0.9,
      estimated: 0.9,
      source: "--threshold / JEV_GATE_THRESHOLD",
    });
  });

  it("matches what the engine actually escalates on, per source", async () => {
    const backend: JevBackend = {
      name: "stub",
      async judge(_request: BackendRequest): Promise<BackendResponse> {
        return {
          // reported 0.45 (below 0.5) beside an estimated 0.45 (at 0.4, fine)
          answers: [
            { answer: "merge", distribution: { merge: 0.9, hold: 0.1 }, confidence: 0.45 },
            { answer: "merge", distribution: { merge: 0.725, hold: 0.275 } },
          ],
          model: "stub",
        };
      },
    };
    const { reported, estimated } = effectiveThresholds();
    const result = await judge(backend, {
      state: "green",
      questions: [
        { id: "a", type: "choice", question: "Next?", options: ["merge", "hold"] },
        { id: "b", type: "choice", question: "Next again?", options: ["merge", "hold"] },
      ],
    });
    expect(result.verdicts[0].confidence).toBeLessThan(reported);
    expect(result.verdicts[0].escalate).toBe(true);
    expect(result.verdicts[1].confidence).toBeGreaterThanOrEqual(estimated);
    expect(result.verdicts[1].escalate).toBe(false);
  });

  it("the help text hard-codes no threshold, so it cannot drift", () => {
    expect(HELP).toContain("JEV_GATE_THRESHOLD");
    expect(HELP).toContain("JEV_GATE_STATE");
    const body = HELP.split("\n").slice(1).join("\n"); // past the version banner
    expect(body).not.toMatch(/0\.\d/);
  });
});
