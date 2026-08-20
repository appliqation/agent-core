// Playwright-backed implementations of the browser_* tool palette. Tool names
// mirror Playwright MCP's own naming convention so any workflow prose written
// against that vocabulary transfers unchanged to this engine.
//
// Two behaviors are injectable rather than hardcoded, so this class has zero
// appq-specific coupling: the destructive-action check before a click
// (defaults to the shared classifyClick()), and where a screenshot gets
// staged for attachment (no default — a consuming agent either wires its own
// appq upload, a local file sink, or neither; browser_take_screenshot still
// works either way, just without a ref to hand back when there's no sink).

import type { Page } from 'playwright';
import type { LlmToolDef, ToolResult } from '../types.js';
import { EvidenceCapture } from '../evidence/capture.js';
import { classifyClick, type ClickTarget } from './destructiveActionGate.js';

export type ClickGate = (target: ClickTarget) => ToolResult | null;

/** Stages a captured screenshot somewhere (an appq upload, a local file, ...) and returns a ref for it. */
export type ScreenshotSink = (
  png: Buffer,
  label: string,
) => Promise<{ ok: true; ref: string } | { ok: false; note: string }>;

export interface BrowserToolsHooks {
  onBeforeClick?: ClickGate;
  screenshotSink?: ScreenshotSink;
}

export const BROWSER_TOOL_DEFS: LlmToolDef[] = [
  {
    name: 'browser_navigate',
    description: 'Navigate the page to a URL.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'browser_navigate_back',
    description: 'Go back to the previous page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_snapshot',
    description:
      'Take an accessibility-tree snapshot of the current page. Returns a text tree with element refs ' +
      '(e1, e2, ...) to use with browser_click/browser_type/etc.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_click',
    description:
      'Click an element by its ref from the last browser_snapshot. `label` must describe the control\'s ' +
      'visible text/purpose (e.g. "Delete account", "Pay now") — it is checked against a destructive-action ' +
      'gate before the click happens.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, label: { type: 'string' } },
      required: ['ref', 'label'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an element by its ref from the last browser_snapshot.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select an option in a <select> element by its ref.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: { type: 'string' } },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key (e.g. "Enter", "Escape").',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'browser_take_screenshot',
    description:
      'Take a screenshot of the current viewport and stage it for attachment. Returns a screenshot_upload_id ' +
      'when a screenshot sink is configured — pass that straight through wherever the calling workflow expects ' +
      'it. You never need to handle the image bytes yourself.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_console_messages',
    description: 'Return console messages logged since the last check.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_network_requests',
    description: 'Return network requests observed since the last check.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for a duration in milliseconds, or for text to appear on the page.',
    inputSchema: {
      type: 'object',
      properties: { millis: { type: 'number' }, text: { type: 'string' } },
    },
  },
  {
    name: 'browser_resize',
    description: 'Resize the browser viewport of the currently selected tab.',
    inputSchema: {
      type: 'object',
      properties: { width: { type: 'number' }, height: { type: 'number' } },
      required: ['width', 'height'],
    },
  },
  {
    name: 'browser_tabs',
    description:
      'List, open, close, or switch between browser tabs. `list` returns every open tab with its index and URL, ' +
      'marking which one is selected. `new` opens a tab (optionally navigating it to `url`) and selects it. ' +
      '`close` closes a tab by `index` (defaults to the selected tab) — at least one tab must remain open. ' +
      '`select` by `index` makes that tab the target of every other browser_* tool. Switching tabs invalidates ' +
      'refs from a prior browser_snapshot — call browser_snapshot again after selecting a different tab.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'close', 'select'] },
        index: { type: 'number' },
        url: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_evaluate',
    description:
      'Run JavaScript in the page context of the currently selected tab and return the result. Pass either a ' +
      'plain expression (e.g. "document.title") or a function (e.g. "() => document.title"). Unrestricted — use ' +
      'for read-only inspection (Service Worker state, Performance API, localStorage, etc.), not to work around ' +
      'the destructive-action gate on browser_click.',
    inputSchema: { type: 'object', properties: { function: { type: 'string' } }, required: ['function'] },
  },
];

/** Wraps a live Playwright Page as a browser_* tool dispatcher, tracking evidence as it goes. */
export class PlaywrightBrowserTools {
  // Refs come from page.ariaSnapshot({mode:'ai'}), which embeds [ref=eN]
  // markers directly in its output — no manual tree-walking needed. A ref
  // resolves back to a live element via the 'aria-ref=' selector engine.
  // Refs are only valid against the page they were snapshotted from, so a
  // tab switch clears them — the model must call browser_snapshot again.
  private knownRefs = new Set<string>();

  // Multi-tab support: every existing browser_* op targets whichever page is
  // currently selected, via currentPage()/currentEvidence(). Consumers that
  // never call browser_tabs see no behavior change — pages always has
  // exactly one entry, selected always 0. Evidence is tracked per page (not
  // just the original one) since console/network listeners are bound at
  // Page construction — a new tab's console output would otherwise be
  // silently invisible to browser_console_messages after switching to it.
  private pages: Page[];
  private selected = 0;
  private evidenceByPage: Map<Page, EvidenceCapture>;

  constructor(
    page: Page,
    private readonly ringBufferCap?: number,
    private readonly hooks: BrowserToolsHooks = {},
  ) {
    this.pages = [page];
    this.evidenceByPage = new Map([[page, new EvidenceCapture(page, ringBufferCap)]]);
  }

  private currentPage(): Page {
    return this.pages[this.selected];
  }

  /** The currently selected tab's evidence tracker — same call shape as the old single-page `.evidence` field. */
  get evidence(): EvidenceCapture {
    return this.evidenceByPage.get(this.currentPage())!;
  }

  private locatorFor(ref: string) {
    if (!this.knownRefs.has(ref)) throw new Error(`Unknown ref "${ref}" — call browser_snapshot first`);
    return this.currentPage().locator(`aria-ref=${ref}`);
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'browser_navigate': {
        await this.currentPage().goto(String(args.url), { waitUntil: 'domcontentloaded' });
        return { ok: true, text: `Navigated to ${args.url}` };
      }
      case 'browser_navigate_back': {
        await this.currentPage().goBack({ waitUntil: 'domcontentloaded' });
        return { ok: true, text: 'Navigated back' };
      }
      case 'browser_snapshot': {
        const text = await this.currentPage().ariaSnapshot({ mode: 'ai' });
        this.knownRefs = new Set([...text.matchAll(/\[ref=([^\]]+)\]/g)].map((m) => m[1]));
        return { ok: true, text: text || '(empty page)' };
      }
      case 'browser_click': {
        const ref = String(args.ref);
        // label is required (not derived from the ref) so the destructive-action
        // gate has something to check before the click ever dispatches.
        const label = String(args.label ?? '');
        const gate = this.hooks.onBeforeClick ?? classifyClick;
        const blocked = gate({ label, tag: 'button' });
        if (blocked) return blocked;
        await this.locatorFor(ref).click();
        return { ok: true, text: `Clicked "${label || ref}"` };
      }
      case 'browser_type': {
        const ref = String(args.ref);
        await this.locatorFor(ref).fill(String(args.text));
        if (args.submit) await this.locatorFor(ref).press('Enter');
        return { ok: true, text: `Typed into ${ref}` };
      }
      case 'browser_select_option': {
        const ref = String(args.ref);
        await this.locatorFor(ref).selectOption(String(args.value));
        return { ok: true, text: `Selected "${args.value}" in ${ref}` };
      }
      case 'browser_press_key': {
        await this.currentPage().keyboard.press(String(args.key));
        return { ok: true, text: `Pressed ${args.key}` };
      }
      case 'browser_take_screenshot': {
        const png = await this.currentPage().screenshot({ type: 'png' });
        if (!this.hooks.screenshotSink) {
          return { ok: true, text: `Captured screenshot (${png.length} bytes). No screenshot sink configured for this agent.`, data: png };
        }
        try {
          const staged = await this.hooks.screenshotSink(png, 'autotest-step');
          if (staged.ok) {
            return { ok: true, text: `Captured screenshot (${png.length} bytes). screenshot_upload_id: ${staged.ref}`, data: png };
          }
          // Non-fatal — the step's other evidence (accessibility snapshot,
          // console/network deltas) still stands on its own; one failed
          // staging attempt shouldn't block the whole step.
          return {
            ok: true,
            text: `Captured screenshot (${png.length} bytes), but staging it failed: ${staged.note}. ` +
              'No screenshot_upload_id available for this step — submit evidence without one.',
            data: png,
          };
        } catch (err) {
          return {
            ok: true,
            text: `Captured screenshot (${png.length} bytes), but staging it failed: ${(err as Error).message}. ` +
              'No screenshot_upload_id available for this step — submit evidence without one.',
            data: png,
          };
        }
      }
      case 'browser_console_messages': {
        return { ok: true, text: JSON.stringify(this.evidence.getConsoleDeltas()) };
      }
      case 'browser_network_requests': {
        return { ok: true, text: JSON.stringify(this.evidence.getNetworkDeltas()) };
      }
      case 'browser_wait_for': {
        if (args.text) {
          await this.currentPage().getByText(String(args.text)).waitFor({ timeout: 15000 });
          return { ok: true, text: `Text "${args.text}" appeared` };
        }
        await this.currentPage().waitForTimeout(Number(args.millis ?? 1000));
        return { ok: true, text: 'Waited' };
      }
      case 'browser_resize': {
        const width = Number(args.width);
        const height = Number(args.height);
        await this.currentPage().setViewportSize({ width, height });
        return { ok: true, text: `Resized viewport to ${width}x${height}` };
      }
      case 'browser_tabs': {
        return this.dispatchTabs(args);
      }
      case 'browser_evaluate': {
        const result = await this.currentPage().evaluate(String(args.function));
        return { ok: true, text: result === undefined ? 'undefined' : JSON.stringify(result) };
      }
      default:
        return { ok: false, text: `Unknown browser tool "${name}"` };
    }
  }

  private async dispatchTabs(args: Record<string, unknown>): Promise<ToolResult> {
    const action = String(args.action ?? '');
    switch (action) {
      case 'list': {
        const lines = this.pages.map((p, i) => `${i}${i === this.selected ? ' (selected)' : ''}: ${p.url()}`);
        return { ok: true, text: lines.join('\n') };
      }
      case 'new': {
        const newPage = await this.currentPage().context().newPage();
        if (args.url) await newPage.goto(String(args.url), { waitUntil: 'domcontentloaded' });
        this.pages.push(newPage);
        this.evidenceByPage.set(newPage, new EvidenceCapture(newPage, this.ringBufferCap));
        this.selected = this.pages.length - 1;
        this.knownRefs = new Set();
        return { ok: true, text: `Opened new tab at index ${this.selected}${args.url ? ` (${args.url})` : ''}` };
      }
      case 'close': {
        const index = args.index !== undefined ? Number(args.index) : this.selected;
        if (!Number.isInteger(index) || index < 0 || index >= this.pages.length) {
          return { ok: false, text: `No tab at index ${args.index}` };
        }
        if (this.pages.length === 1) return { ok: false, text: 'Cannot close the only remaining tab' };
        const [closed] = this.pages.splice(index, 1);
        this.evidenceByPage.delete(closed);
        await closed.close();
        if (this.selected >= this.pages.length) this.selected = this.pages.length - 1;
        else if (this.selected > index) this.selected -= 1;
        this.knownRefs = new Set();
        return { ok: true, text: `Closed tab ${index}. Now on tab ${this.selected} (${this.currentPage().url()}).` };
      }
      case 'select': {
        const index = Number(args.index);
        if (!Number.isInteger(index) || index < 0 || index >= this.pages.length) {
          return { ok: false, text: `No tab at index ${args.index}` };
        }
        this.selected = index;
        this.knownRefs = new Set();
        return { ok: true, text: `Selected tab ${index} (${this.currentPage().url()})` };
      }
      default:
        return { ok: false, text: `Unknown browser_tabs action "${action}"` };
    }
  }
}
