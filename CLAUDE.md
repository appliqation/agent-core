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
  locators. Tracks a `pages: Page[]` + `selected` index rather than one fixed `Page` —
  `browser_tabs` (list/new/close/select) is the only thing that ever changes `selected`;
  every other `browser_*` op (including `browser_resize` and the unrestricted
  `browser_evaluate`) targets `currentPage()`, so a consumer that never calls
  `browser_tabs` sees no behavior change. Evidence (`EvidenceCapture`, console/network
  listeners) is tracked **per page**, not just the original one — console/network
  listeners are bound at `Page` construction, so a new tab's own evidence would
  otherwise be invisible to `browser_console_messages`/`browser_network_requests`
  after switching to it. A tab switch clears `knownRefs`: `aria-ref=` locators only
  resolve against the page they were snapshotted from), `apiTools.ts`
  (`ApiRequestTools`/`API_TOOL_DEFS` — a single `http_request` tool wrapping a
  Playwright `APIRequestContext`; dry-run write-verb suppression built into `dispatch()`
  itself, not a separate wrapper), `authState.ts` (`resolveStorageState(projectId, role)`
  — reads the Playwright storageState `@appliqation/automation-sdk`'s `setupAuth()`
  resolves, fail-closed if missing, never performs login or handles credentials itself;
  `resolveApiAuth(projectId, role)` — reads `APPQ_PROJECT_<id>_<ROLE>_API_KEY`/
  `_API_HEADER_NAME` from `process.env`, returns `undefined` (not throwing) when
  unconfigured, since API auth is legitimately optional unlike UI storage state),
  `roleInference.ts` (`knownRolesForProject()`/`inferRole()`/`isApiTest()`/
  `parseScenarioTcList()` — deterministic, never-LLM per-TC role/test-type inference for
  mixed scenarios; see `appliqation-autotest/CLAUDE.md`'s "Per-TC role inference" for the
  full precedence reasoning, unchanged by the move), `projectContext.ts`
  (`PROJECT_CONTEXT_TOOL`/`createReadOnlyProjectContextDispatcher()` — the
  argument-level gate `enrich_project_context` needs, since tool-*name* allowlisting
  can't express "this tool, but only this argument value"; promoted here from
  `appliqation-autopilot` once a second unsupervised agent — `appliqation-explorer` —
  needed the identical guarantee. Allowlists the one safe shape, `action=read`, rather
  than denylisting the unsafe one, so a missing or malformed `action` is refused too,
  not just an explicit `"write"`).
- `src/evidence/capture.ts` — `EvidenceCapture`: screenshot/console/network/accessibility-
  snapshot capture via native Playwright/CDP APIs (`page.on('console'/'request'/...)`,
  `page.screenshot()`, `page.ariaSnapshot()`), cursor-based delta reads
  (`getConsoleDeltas()`/`getNetworkDeltas()`) so repeated calls only return what's new.
- `src/config/helpers.ts` — `required()`/`optional()`, the only two config primitives
  shared. Deliberately **not** a shared config schema/singleton — each consuming agent's
  `.env` shape is genuinely different (autotest has an executor/validator model split and
  an image-check knob; a future agent won't), so each agent keeps its own frozen `config`
  object built from these two functions, not a generalized `buildConfig(schema)`.
- `src/audit/sink.ts` — `AuditRecord`/`AuditSink`, `createMongoAuditSink()`/
  `createJsonlAuditSink()`/`noopAuditSink`, `resolveAuditSink(env)` (precedence: Mongo >
  JSONL > noop, mirroring `resolveProvider()`'s own shape — nothing writes anywhere
  unless a consuming agent's `.env` configures it, same BYO posture as every LLM key),
  `createUsageAccumulator()` (sums a run's `'usage'` onEvent callbacks into one
  invocation-level total), and `safeRecord(sink, entry)` — **the one function every
  consuming CLI should actually call**, not `sink.record()` directly: it catches and
  logs any write failure rather than propagating it, since an audit write is
  observability about a run, not part of the run itself, and must never be able to fail
  or slow down the real task it's describing. Deliberately **not** a knowledge channel:
  an `AuditRecord` is read by a human later (`appliqation-dashboard`), never fed back
  into a future agent's own decisions — a genuinely different trust question from
  `enrich_project_context`'s write boundary (`tools/projectContext.ts`), which exists
  precisely because writes *there* would be treated as established fact by later runs.
  `outcome` is deliberately just the consuming CLI's own already-built `--json` summary
  object, passed through verbatim — no second schema to keep in sync with
  `RunSummary`/`GenerateSummary`/etc. First and, as of this writing, only consumer of
  the real `mongodb` npm driver in this package (matches `workers/automan-worker`'s own
  pinned version) — every other module here has stayed dependency-light on purpose;
  this is the one place persistence genuinely can't be avoided.

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
