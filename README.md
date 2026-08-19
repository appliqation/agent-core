# @appliqation/agent-core

**The shared engine every standalone Appliqation agent is built from.** Not an app on its own — no CLI, no `.env` — just the generic, workflow-agnostic pieces that [`appliqation-autotest`](https://github.com/appliqation/appliqation-autotest), [`appliqation-scriptgen`](https://github.com/appliqation/appliqation-scriptgen), and [`appliqation-defect-fix`](https://github.com/appliqation/appliqation-defect-fix) each build on:

- **`/engine`** — the think→act→observe tool-calling loop, budget tracking (calls/pages/time/turns), and a workflow runner that fetches a named prompt (from Appliqation's MCP server or a local file) and runs it through that loop.
- **`/appq`** — a JSON-RPC client for Appliqation's MCP API, plus scenario/test-set/run resolvers that always derive `project_id`/`url` from a source of truth (a scenario ID, a TC UUID) rather than accepting a second, possibly-diverging input.
- **`/providers`** — Anthropic and OpenAI adapters implementing one common interface, including prompt caching and image-handling for both wire formats.
- **`/tools`** — a Playwright-backed browser-tool palette, the tool-allowlist gating mechanism every agent's own safety boundary is built on, a destructive-action click gate, auth-session resolution, and per-test-case role inference.
- **`/evidence`** — screenshot/console/network/accessibility-snapshot capture with cursor-based delta reads.

## Design principle: mechanism shared, domain knowledge local

Every module here is either genuinely universal, or an explicit injection point so a consuming agent can supply its own domain knowledge without this package needing to know about it. Two examples:

- **Tool-dispatch gating** (`tools/gatedDispatcher.ts`) enforces "only call tools in this allowlist" — but the allowlist *itself* (which tools an executor vs. validator vs. any other stage may touch) is each consuming agent's own knowledge, kept in that agent's own code, never here.
- **Browser tools** (`tools/browserTools.ts`) take optional `{onBeforeClick, screenshotSink}` hooks instead of hardcoding a destructive-action policy or an upload destination — a consuming agent with no write access, or a different safety posture, supplies its own.

## Installation

Not yet published to npm — consumed via a `file:` dependency by every agent in this family until it is:

```json
"dependencies": {
  "@appliqation/agent-core": "file:../appliqation-agent-core"
}
```

## Development

```bash
npm run build
npm run typecheck
npm test
```

See `CLAUDE.md` for a map of this repo if you're working in it with an AI coding assistant.

## License

MIT — see [LICENSE](./LICENSE).
