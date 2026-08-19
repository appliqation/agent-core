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
