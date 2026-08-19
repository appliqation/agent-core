# CLAUDE.md — appliqation-agent-core

Part of the Appliqation workspace. See `~/Sites/localhost/CLAUDE.md` for how the
product fits together; this file is the map of **this repo only**.

## What this repo is

A shared npm package (`@appliqation/agent-core`) holding the generic, workflow-agnostic
engine every standalone Appliqation agent is built from — not an app on its own, no CLI,
no `.env`. Extracted out of `appliqation-autotest` (see that repo's `CLAUDE.md`,
"Migrated onto `@appliqation/agent-core`") once a second consumer agent was designed
(`appliqation-scriptgen`, a script-generation agent — not yet built at time of writing).
`appliqation-autotest` has already been migrated onto this package; it's the reference
consumer to look at for real usage examples of everything below.

**Not yet published to npm.** Consumed locally via `file:../appliqation-agent-core`
dependencies until it is — switch those to a real version pin (`^0.1.0` etc.) once
published, mirroring how `@appliqation/automation-sdk` (`automation-sdk-js/`) is
published and consumed.

## Design principle: mechanism shared, domain knowledge local

Every module here is either genuinely universal (no appq-specific *content*, only
generic *mechanism*) or an explicit factory/injection point so a consuming agent can
supply its own domain knowledge without this package needing to know about it. Two
concrete examples worth understanding before changing anything:

- **Tool-dispatch gating**: `tools/gatedDispatcher.ts`'s `assertToolAllowed()` /
  `createGatedAppqDispatcher()` enforce "only call tools in this allowlist" — but the
  allowlist *itself* (which appq tools an executor vs. validator vs. any other stage may
  touch) is each consuming agent's own domain knowledge, kept in that agent's own
  `tools/safety.ts`, never here. Don't add appq-tool-name-specific logic to this file.
- **Browser tools**: `tools/browserTools.ts`'s `PlaywrightBrowserTools` takes optional
  `{onBeforeClick, screenshotSink}` hooks in its constructor instead of hardcoding a
  destructive-action policy or an appq upload call. `onBeforeClick` defaults to the
  shared `destructiveActionGate.ts`'s `classifyClick` (genuinely universal — inspects
  only a click's accessible label, no appq coupling, safe to default). `screenshotSink`
  has no default — a consuming agent wires its own (an appq upload, a local file, or
  nothing at all) via `browserTools.ts`'s injection point; without one,
  `browser_take_screenshot` still works, it just returns no upload ref.

The `mcpClient.ts` factory (`createMcpClient({origin, apiKey})`) follows the same idea —
each consuming agent constructs one client from its own config and threads it down
explicitly (the "construct once, pass down" pattern), rather than this package holding a
module-level singleton reading a global config object that wouldn't make sense shared
across agents with different `.env` shapes.

## Where to find what

- `src/types.ts` — the core shared type surface: `LlmMessage`, `LlmToolDef`,
  `LlmToolCall`, `LlmImage`, `LlmCompleteResult`, `ProviderAdapter`, `ToolResult`,
  `RunBudget`, `ToolDispatcher`, `WorkflowRunOptions`/`WorkflowRunResult`.
- `src/engine/` — `loop.ts` (`runLoop()`, the think→act→observe loop — workflow-agnostic,
  takes a system prompt/tools/dispatcher/budget and runs until the model's turn has zero
  tool calls, with a hard turn/call/time budget cap), `budget.ts` (`BudgetTracker`),
  `workflowRunner.ts` (`runWorkflow()` — fetches a named workflow's text, either via an
  explicit `fetchPrompt` function param for `{kind:'appq', name, args}` sources, or from a
  local file for `{kind:'local', path}` sources, then runs it through `runLoop()`).
- `src/appq/` — `mcpClient.ts` (`createMcpClient({origin, apiKey})`: JSON-RPC client to
  `/api/appq/mcp` — `fetchPrompt()` (`prompts/get` — pass the **full** name, e.g.
  `appq:runman`), `startWorkflow()`, `callTool()`, `listTools()`, `uploadScreenshot()`
  (separate REST endpoint, must send `Content-Type: image/png` exactly — appq's endpoint
  415s on `application/octet-stream`)), `scenarioResolvers.ts` (`resolveScenarioId`/
  `fetchScenarioInfo`/`resolveUrl`/`resolveRun`, each taking an `McpClient` param —
  project_id/url are always derived from scenario_id/environment, never accepted as
  separate inputs that could silently diverge from the real value; `scenarioIdFromTcUuid()`
  parses the `{scenario_id}-{uuid4}` TC UUID format appq's own tools use).
- `src/providers/` — `anthropic.ts`/`openai.ts`: official `@anthropic-ai/sdk`/`openai`
  adapters implementing `ProviderAdapter`, model/max-tokens passed in by the caller (no
  default model baked in beyond a `DEFAULT_*_MODEL` fallback constant). The Anthropic
  adapter sets `cache_control` breakpoints (system prompt, tool defs, growing message
  history) since the system prompt/tools are typically static and reused across every
  turn. Both handle `LlmMessage.images` on tool results — Anthropic inline in the
  `tool_result` block, OpenAI as a synthetic follow-up `input_image` message (the
  Responses API has no way to attach an image to a function output directly).
- `src/tools/` — `gatedDispatcher.ts` (the tool-allowlist enforcement *mechanism* — see
  "Design principle" above), `destructiveActionGate.ts` (`classifyClick` — destructive-verb/
  mailto:/tel:/sms: regex bank, checked before any click dispatches; genuinely universal),
  `browserTools.ts` (`PlaywrightBrowserTools`/`BROWSER_TOOL_DEFS` — Playwright-backed
  `browser_*` tool palette, ref-based via `page.ariaSnapshot({mode:'ai'})` + `aria-ref=`
  locators), `authState.ts` (`resolveStorageState(projectId, role)` — reads the
  Playwright storageState `@appliqation/automation-sdk`'s `setupAuth()` resolves,
  fail-closed if missing; never performs login or handles credentials itself),
  `roleInference.ts` (`knownRolesForProject()`/`inferRole()`/`parseScenarioTcList()` —
  deterministic, never-LLM per-TC role inference for mixed-role scenarios; see
  `appliqation-autotest/CLAUDE.md`'s "Per-TC role inference" for the full precedence
  reasoning, unchanged by the move).
- `src/evidence/capture.ts` — `EvidenceCapture`: screenshot/console/network/accessibility-
  snapshot capture via native Playwright/CDP APIs (`page.on('console'/'request'/...)`,
  `page.screenshot()`, `page.ariaSnapshot()`), cursor-based delta reads
  (`getConsoleDeltas()`/`getNetworkDeltas()`) so repeated calls only return what's new.
- `src/config/helpers.ts` — `required()`/`optional()`, the only two config primitives
  shared. Deliberately **not** a shared config schema/singleton — each consuming agent's
  `.env` shape is genuinely different (autotest has an executor/validator model split and
  an image-check knob; a future agent won't), so each agent keeps its own frozen `config`
  object built from these two functions, not a generalized `buildConfig(schema)`.

## Commands

- `npm run build` — `tsc -p tsconfig.json` (emits `.d.ts` too — this is a library)
- `npm run typecheck` — `tsc -p tsconfig.json --noEmit`
- `npm test` / `npm run test:watch` — vitest, colocated `src/**/*.test.ts` files
- No `dev`/CLI script — this package has no entrypoint of its own to run.

## Keeping this file current

When you add, remove, or rename a top-level file or a directory under `src/`, update the
map above in the same change — and check whether `appliqation-autotest/CLAUDE.md`'s
references to this package need the same update, since it's the primary consumer
documenting real usage. When a second/third agent starts consuming this package, note
here whether anything moved from "local to that agent" into this shared package, and why.
