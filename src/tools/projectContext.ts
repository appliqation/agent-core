// enrich_project_context support: a hardcoded, non-negotiable argument-level
// gate, the same class of thing as destructiveActionGate.ts's click-verb
// check or a consuming agent's own commandGate-style argv-shape check — just
// applied to one argument value instead of a tool name or command shape.
//
// The tool itself has both action=read and action=write modes. A "zero
// write tools" invariant is normally enforced by tool-NAME allowlisting
// (gatedDispatcher.ts), which can't express "this one tool, but only this
// one argument value" — so this dispatcher-level interceptor is what
// actually keeps the guarantee true for this specific tool. Allowlists the
// one safe shape (action=read) rather than denylisting the unsafe one:
// anything that isn't explicitly "read" is refused, including a missing or
// malformed action, not just an explicit "write".
//
// Shared here (not local to one agent) because more than one unsupervised
// agent needs the identical guarantee: an interactive appq workflow prompt
// may itself instruct a write-back as "persistent memory" once a human has
// reviewed its report, but a headless agent has no equivalent supervision
// moment, so it holds the conservative default regardless of what the
// served prompt asks for.

import type { ToolDispatcher, ToolResult } from '../types.js';

export const PROJECT_CONTEXT_TOOL = 'enrich_project_context';

export function createReadOnlyProjectContextDispatcher(inner: ToolDispatcher): ToolDispatcher {
  return async (name, args) => {
    if (name !== PROJECT_CONTEXT_TOOL) return inner(name, args);

    if (args.action !== 'read') {
      return {
        ok: false,
        text:
          `${PROJECT_CONTEXT_TOOL} is read-only for this agent — action "${String(args.action)}" is refused. ` +
          'This is a hardcoded boundary, not a prompt-adjustable one: this agent never writes to the project ' +
          'context document, only reads it.',
      } satisfies ToolResult;
    }

    return inner(name, args);
  };
}
