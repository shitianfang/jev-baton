# Reference

<img src="../assets/loop.svg" alt="The loop sends state and typed questions to Jev; verdicts come back with confidence; escalations wake the LLM; generated results rejoin the loop" width="100%">

## `jev_judge`

Batch every question about one state into one call — latency is flat in
question count ([measured](https://github.com/Nyarlathoteppppp/pi-heed/blob/main/EXPERIMENTS.md):
1/4/8 questions ≈ 274 ms median), and cost amortizes across the shared state.

| Param | Type | Notes |
| --- | --- | --- |
| `state` | string | everything Jev may consider — facts, tool output, file excerpts (≤ ~30k tokens) |
| `questions[]` | array | each: `{id?, type, question, options?, levels?, criteria?}` |
| `questions[].type` | `noul` \| `choice` \| `score` | noul = probability a statement is true; choice = pick one enumerated option; score = position on an ordered list of levels |
| `questions[].options` | choice only | ≥ 2 labels, or a `label → meaning` map |
| `questions[].levels` | score only | ≥ 2 ordered level descriptions |
| `questions[].criteria` | noul only, optional | `{true, false}` meanings, to sharpen calibration |
| `confidence_threshold` | number, default per confidence source — `0.5` reported, `0.4` estimated | verdicts below it escalate |
| `model` | string, optional | backend model override |

```jsonc
// input
{
  "state": "CI run #142: build ok, 214 tests passed, 0 failed; 1 test quarantined as flaky last week",
  "questions": [
    { "id": "passed", "type": "noul",   "question": "Did the run fully succeed?" },
    { "id": "next",  "type": "choice", "question": "Next action?",
      "options": { "merge": "everything green", "rerun": "looks flaky", "hold": "needs attention" } },
    { "id": "risk",  "type": "score",  "question": "How risky is merging now?",
      "levels": ["routine", "worth a look", "incident"] }
  ]
}
```

```jsonc
// result (shape exact, values illustrative)
{
  "verdicts": [
    { "id": "passed", "type": "noul",   "answer": 0.97, "confidence": 0.94,
      "confidenceFrom": "estimated", "escalate": false },
    { "id": "next",  "type": "choice", "answer": "merge", "confidence": 0.34,
      "confidenceFrom": "reported", "escalate": true,
      "reason": "unsure", "distribution": { "merge": 0.55, "rerun": 0.41, "hold": 0.04 },
      "hint": "Jev answered (merge) at reported confidence 0.34 < 0.5. Treat the answer as a prior, not a decision — reason it out yourself." },
    { "id": "risk",  "type": "score",  "answer": 0.8, "confidence": 0.81,
      "confidenceFrom": "reported", "escalate": false,
      "distribution": { "0": 0.35, "1": 0.5, "2": 0.15 },
      "legend": { "0": "routine", "1": "worth a look", "2": "incident" } }
  ],
  "escalated": true,
  "backend": "typesafe",
  "latencyMs": 187
}
```

A score `answer` is the distribution's expected position on your levels —
`0.8` means "between *routine* and *worth a look*, closer to the latter";
`legend` maps indices back to your words.

## `jev_gate`

One proposed action, one risk check.

| Param | Type |
| --- | --- |
| `state` | string — current task context |
| `tool`, `input` | the action, verbatim |
| `description` | optional intent |
| `confidence_threshold` | default per confidence source (`0.5` reported / `0.4` estimated) |

Returns `{decision: allow | deny | escalate, confidence, confidenceFrom, hint}` — one
allow/deny `choice` under the hood, `escalate` when confidence falls below
the threshold. **`allow` stays silent and falls through to your normal
permission flow — the gate can never grant anything. A provider that is down
escalates with the reason `unreachable`, never to `allow`.** Claude's default
adapter maps escalation to `ask`; `hook gate --codex` maps it to a blocking
handoff because Codex does not support `ask`.

The action is the one part of the judged state you did not write, so its
credentials are redacted before the call ([src/redact.ts](../src/redact.ts)):
URL passwords, auth and cookie headers, `-u user:pass`, `--token=`/`SECRET=`
values, and known key shapes become `[redacted]`. Everything the answer
depends on — the tool, the flags, the host, the path — is sent as-is, and a
value that is only a reference (`$GITHUB_TOKEN`) is left alone. What the
removal costs the verdict is measured in [bench/RESULTS.md](../bench/RESULTS.md). As a PreToolUse hook it spends zero LLM
tokens on the allow path (a deny/ask feeds its reason back to the model —
that is the point) and adds one ~100 ms round trip per gated call, so scope
the matcher to tools worth gating.

## The verdict contract

Every verdict:
`{id, type, answer, confidence, confidenceFrom, escalate, reason?, hint?, distribution?, legend?}`.
`reason`/`hint` appear exactly when `escalate` is true; `distribution`/`legend`
whenever the provider returns them; `confidenceFrom` whenever the question
actually reached Jev.

| reason | when | meaning |
| --- | --- | --- |
| `writing` | pre-call | the step must produce new text/code — structurally the LLM's |
| `open_ended` | pre-call | not expressible as noul/choice/score (nothing to enumerate) |
| `oversized` | pre-call | the state exceeds ~30k tokens — shrink it or take the questions over |
| `unsure` | post-call | answer too flat to act on; it stays in `answer` as a prior |
| `unreachable` | on failure | Jev unreachable — proceed as if it didn't exist |

Pre-call reasons come from a deterministic router (no request spent); each
handback is a normal verdict with a hint, never an exception.

**What the `confidence` scalar is, and where it came from.** Every verdict
says so itself, in `confidenceFrom`:

| `confidenceFrom` | who produced it | escalates below |
| --- | --- | --- |
| `reported` | Jev's own confidence head, returned for `choice` and `score` answers | `0.5` |
| `estimated` | jev-use, from the answer's own distribution: top-minus-runner-up for `choice`/`score`, `2·\|p − 0.5\|` for `noul` | `0.4` |

`noul` answers carry no reported confidence from any provider, so they are
always `estimated`; one batch mixing `check` with `pick`/`rate` therefore comes
back part reported, part estimated, and each verdict is judged against its own
number. Through the Vercel gateway the head arrives out-of-band in
`providerMetadata.typesafe.confidence`, keyed by question id.

The two are the same scale read two ways, measured over 318 live
choice/score answers ([bench/RESULTS.md](../bench/RESULTS.md)): on a
two-option question they agree to the wire's 2-decimal rounding, and on
three or more the margin reads a median `0.05` (up to `0.17`) lower, because
it also subtracts however the losing mass splits. Hence the lower bar for
the estimate. An explicit `confidence_threshold` covers every verdict
whatever its source, and always wins.

## Library

```js
import { Jev, check, pick, rate } from "jev-use";

const jev = new Jev();                 // backend resolved from the environment

const { answers, verdicts } = await jev.judge(state, {
  next: pick("Next action?", { merge: "all green", rerun: "looks flaky", hold: "needs attention" }),
  risk: rate("How risky?", ["routine", "worth a look", "incident"]),
  passed: check("Did the run fully succeed?"),
});
answers.next;   // { answer: "merge", confidence: 0.93, confidenceFrom: "reported", escalate: false }

const verdict = await jev.gate(state, { tool: "Bash", input: { command } });
verdict.decision;   // "allow" | "deny" | "escalate"
```

Both halves of the handoff are in the surface. Before writing a question,
`route` says whether the step is Jev-shaped at all — no client, no key, no
call:

```js
import { route } from "jev-use";

route({ producesContent: true, enumerable: true });    // { to: "llm", reason: "writing" }
route({ producesContent: false, enumerable: false });  // { to: "llm", reason: "open_ended" }
route({ producesContent: false, enumerable: true });   // { to: "jev" }
```

After the call, every answer carries the other half — `escalate`, `reason`,
`hint`, and Jev's answer kept as a prior ([the table above](#the-verdict-contract)).

The three builders write the three primitives — `check` → `noul`, `pick` →
`choice`, `rate` → `score` — and the wire vocabulary stays exactly that.
`answers` is keyed by the names you asked under; `verdicts` is the same
verdicts in the order you asked them, alongside `escalated`, `backend`,
`model`, `latencyMs` and `usage`.

`new Jev({ backend: "mock" })` judges with no key at all, and
`new Jev({ backend: myBackend })` takes any `JevBackend` (tests, custom
transports). Defaults set on the client — `confidenceThreshold`, `model` —
are overridable per call: `jev.judge(state, questions, { model })`.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `JEV_BACKEND` | auto-detect | `typesafe` \| `openrouter` \| `vercel` \| `mock` |
| `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY` / `AI_GATEWAY_API_KEY` | — | provider credential; auto-detected in this order |
| `JEV_MODEL` | provider default (`jev-latest`) | model override |
| `JEV_GATE_THRESHOLD` | per confidence source (`0.5` / `0.4`) | hook-gate escalation threshold, for both sources at once |

Provider dialects: TypeSafe and OpenRouter share the native wire shape
(OpenRouter's `decisions` endpoint is alpha and may move), carrying
`confidence` on the answer itself; Vercel's gateway renames `noul`→`boolean`,
moves the model into a header, drops the `legend` echo, and relays the
confidence head in `providerMetadata.typesafe.confidence` instead — a map keyed
by question id, with `boolean` answers absent from it. All three are normalized
by the adapters, provenance included; wire shapes are
pinned by fixture tests against documented formats — `jev-use doctor` is the
live check.

## CLI

```
jev-use install [claude|codex|pi]   wire the server into your harness via its own CLI (all found, if no target)
jev-use serve                 stdio MCP server
jev-use hook gate [--codex]   PreToolUse hook adapter (Claude Code / Codex)
jev-use judge ['{...}']       one-shot JudgeRequest from argv or stdin
jev-use doctor                backend resolution + one live round trip
```
