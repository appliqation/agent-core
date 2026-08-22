// Destructive-action gate, checked before any click/submit dispatches. Pure
// — inspects only a click's accessible label, no appq coupling — shared by
// every consuming agent that drives a real browser.

import type { ToolResult } from '../types.js';

export interface ClickTarget {
  label: string;
  tag: string;
  type?: string;
  href?: string;
}

// Final-step or side-effecting verbs. Checked against the accessible label of
// whatever's about to be clicked, before the click happens. Headless/CI runs
// have no human watching the transcript live, so this blocks outright on any
// match rather than a softer "proceed until the final commit step" policy —
// side effects (reserved inventory, sent OTPs, draft orders) can happen
// before a final confirmation even without anyone reviewing in real time.
export const DESTRUCTIVE_VERBS = [
  /\bpay( now)?\b/i,
  /\bpurchase\b/i,
  /\bplace (the )?order\b/i,
  /\bbuy now\b/i,
  /\bcheckout\b/i,
  /\bconfirm (and )?(pay|purchase|order|delete|remove)\b/i,
  /\bdelete\b/i,
  /\bremove (account|everything)\b/i,
  /\bsend (message|email|invite)\b/i,
  /\bpublish\b/i,
  /\bsubmit (order|payment)\b/i,
  /\bunsubscribe\b/i,
  /\bcancel (subscription|account)\b/i,
];

export function classifyClick(target: ClickTarget): ToolResult | null {
  const text = `${target.label} ${target.type ?? ''}`.trim();

  if (target.href && /^(mailto:|sms:|tel:)/i.test(target.href)) {
    return { ok: false, text: `Blocked: external contact link (${target.href}). Not triggered.` };
  }

  if (DESTRUCTIVE_VERBS.some((re) => re.test(text))) {
    return {
      ok: false,
      text:
        `Blocked: destructive/side-effecting control "${target.label}". This step was not ` +
        `executed — mark the outcome as blocked/needs-review here rather than guessing a verdict, ` +
        `and note in the report that verification stopped at this control.`,
    };
  }
  return null;
}

// browser_evaluate runs arbitrary JS with no per-target label to check, so it
// can't reuse classifyClick() directly — but it's the one place the same
// gate can otherwise be walked around entirely: simulate the click/submit
// browser_click would have blocked, or fire the write request directly,
// neither of which ever reaches classifyClick(). This is a best-effort
// static scan, not a full solution — it catches a model reproducing the
// obvious action (what actually happens in practice), not a determined,
// obfuscated bypass; arbitrary-JS execution has no code-level way to close
// that gap completely, the same trust model Playwright MCP's own
// browser_evaluate already accepts.
const DOM_MUTATION_CALL_RE = /\.(click|submit|requestSubmit)\s*\(|\bdispatchEvent\s*\(/i;
const WRITE_FETCH_RE = /\bmethod\s*:\s*['"](post|put|patch|delete)['"]/i;
const XHR_OPEN_WRITE_RE = /\.open\s*\(\s*['"](post|put|patch|delete)['"]/i;

export function classifyEvaluate(functionSource: string): ToolResult | null {
  if (
    DOM_MUTATION_CALL_RE.test(functionSource) ||
    WRITE_FETCH_RE.test(functionSource) ||
    XHR_OPEN_WRITE_RE.test(functionSource)
  ) {
    return {
      ok: false,
      text:
        'Blocked: this script simulates a click/submit or sends a write-verb (POST/PUT/PATCH/DELETE) ' +
        'request, either of which could bypass browser_click\'s destructive-action gate. Not executed — ' +
        'use browser_click on the real control if this is a genuine step, or keep browser_evaluate to ' +
        'read-only inspection.',
    };
  }
  return null;
}
