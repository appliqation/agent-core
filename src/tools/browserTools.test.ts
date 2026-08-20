import { describe, it, expect, vi } from 'vitest';
import { PlaywrightBrowserTools, type ScreenshotSink } from './browserTools.js';
import type { Page } from 'playwright';

function fakeLocator() {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
  };
}

function fakePage(url = 'https://example.com') {
  const locator = fakeLocator();
  const handlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
  const page = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      (handlers[event] ??= []).push(handler);
    }),
    goto: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    ariaSnapshot: vi.fn().mockResolvedValue('- generic [ref=e1]:\n  - textbox [ref=e2]'),
    locator: vi.fn().mockReturnValue(locator),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    screenshot: vi.fn().mockResolvedValue(Buffer.from([1, 2, 3, 4])),
    getByText: vi.fn().mockReturnValue({ waitFor: vi.fn().mockResolvedValue(undefined) }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(url),
    close: vi.fn().mockResolvedValue(undefined),
    context: vi.fn(),
  };
  return { page: page as unknown as Page, locator, handlers };
}

function fireConsole(handlers: ReturnType<typeof fakePage>['handlers'], type: string, text: string) {
  for (const h of handlers.console ?? []) h({ type: () => type, text: () => text });
}

function fireRequestFailed(handlers: ReturnType<typeof fakePage>['handlers'], method: string, url: string) {
  for (const h of handlers.requestfailed ?? []) h({ method: () => method, url: () => url });
}

describe('PlaywrightBrowserTools', () => {
  it('browser_navigate calls page.goto and waits for domcontentloaded', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_navigate', { url: 'https://example.com' });
    expect(page.goto).toHaveBeenCalledWith('https://example.com', { waitUntil: 'domcontentloaded' });
    expect(result.text).toBe('Navigated to https://example.com');
  });

  it('browser_navigate_back calls page.goBack', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_navigate_back', {});
    expect(page.goBack).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded' });
  });

  it('browser_snapshot returns the raw text and tracks refs for later use', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_snapshot', {});
    expect(result.text).toContain('[ref=e1]');
    // Refs are only usable after this — implicitly proven by the click test below.
  });

  it('browser_snapshot reports "(empty page)" for a blank accessibility tree', async () => {
    const { page } = fakePage();
    (page.ariaSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue('');
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_snapshot', {});
    expect(result.text).toBe('(empty page)');
  });

  it('browser_click throws for a ref that was never seen in a snapshot', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await expect(tools.dispatch('browser_click', { ref: 'e99', label: 'Save' })).rejects.toThrow(/Unknown ref "e99"/);
  });

  it('browser_click succeeds for a ref that was seen in the last snapshot', async () => {
    const { page, locator } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    const result = await tools.dispatch('browser_click', { ref: 'e2', label: 'Continue' });
    expect(locator.click).toHaveBeenCalled();
    expect(result.text).toBe('Clicked "Continue"');
  });

  it('browser_click succeeds for a frame-prefixed ref (f<frame>e<n>) — real Playwright output on pages with iframe content, not just bare e<n>', async () => {
    const { page, locator } = fakePage();
    (page.ariaSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue('- generic [ref=f1e30]:\n  - button "Submit" [ref=f1e55]:');
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    const result = await tools.dispatch('browser_click', { ref: 'f1e55', label: 'Continue' });
    expect(locator.click).toHaveBeenCalled();
    expect(result.text).toBe('Clicked "Continue"');
  });

  it('browser_snapshot tracks both bare and frame-prefixed refs from the same tree', async () => {
    const { page, locator } = fakePage();
    (page.ariaSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue('- generic [ref=e1]:\n  - textbox [ref=f1e2]:');
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    await tools.dispatch('browser_click', { ref: 'e1', label: 'Continue' });
    await tools.dispatch('browser_type', { ref: 'f1e2', text: 'hello' });
    expect(locator.click).toHaveBeenCalled();
    expect(locator.fill).toHaveBeenCalledWith('hello');
  });

  it('browser_click is blocked by the default destructive-action gate before ever touching the page', async () => {
    const { page, locator } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    const result = await tools.dispatch('browser_click', { ref: 'e2', label: 'Delete account' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/Blocked/);
    expect(locator.click).not.toHaveBeenCalled();
  });

  it('an injected onBeforeClick hook overrides the default gate', async () => {
    const { page, locator } = fakePage();
    const customGate = vi.fn().mockReturnValue({ ok: false, text: 'Blocked by custom policy' });
    const tools = new PlaywrightBrowserTools(page, undefined, { onBeforeClick: customGate });
    await tools.dispatch('browser_snapshot', {});
    const result = await tools.dispatch('browser_click', { ref: 'e2', label: 'Continue' }); // safe label under the default gate
    expect(customGate).toHaveBeenCalledWith({ label: 'Continue', tag: 'button' });
    expect(result.text).toBe('Blocked by custom policy');
    expect(locator.click).not.toHaveBeenCalled();
  });

  it('refs from an older snapshot are invalidated by a newer one', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {}); // sees e1, e2
    (page.ariaSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue('- generic [ref=f1]:');
    await tools.dispatch('browser_snapshot', {}); // sees only f1 now
    await expect(tools.dispatch('browser_click', { ref: 'e2', label: 'Continue' })).rejects.toThrow(/Unknown ref "e2"/);
  });

  it('browser_type fills the element and does not press Enter unless submit is set', async () => {
    const { page, locator } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    await tools.dispatch('browser_type', { ref: 'e2', text: 'hello@example.com' });
    expect(locator.fill).toHaveBeenCalledWith('hello@example.com');
    expect(locator.press).not.toHaveBeenCalled();
  });

  it('browser_type presses Enter when submit is true', async () => {
    const { page, locator } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    await tools.dispatch('browser_type', { ref: 'e2', text: 'search term', submit: true });
    expect(locator.press).toHaveBeenCalledWith('Enter');
  });

  it('browser_select_option selects the given value', async () => {
    const { page, locator } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_snapshot', {});
    const result = await tools.dispatch('browser_select_option', { ref: 'e2', value: 'Daily' });
    expect(locator.selectOption).toHaveBeenCalledWith('Daily');
    expect(result.text).toBe('Selected "Daily" in e2');
  });

  it('browser_press_key presses the given key on the keyboard, not a specific element', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_press_key', { key: 'Escape' });
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
  });

  describe('browser_take_screenshot', () => {
    it('with no screenshotSink configured, still returns ok with no upload ref', async () => {
      const { page } = fakePage();
      const tools = new PlaywrightBrowserTools(page);
      const result = await tools.dispatch('browser_take_screenshot', {});
      expect(result.ok).toBe(true);
      expect(result.text).toMatch(/No screenshot sink configured/);
      expect(result.text).not.toContain('screenshot_upload_id:');
      expect(result.data).toEqual(Buffer.from([1, 2, 3, 4]));
    });

    it('stages the PNG via the injected sink and returns its ref for pass-through', async () => {
      const { page } = fakePage();
      const sink: ScreenshotSink = vi.fn().mockResolvedValue({ ok: true, ref: 'upload-id-123' });
      const tools = new PlaywrightBrowserTools(page, undefined, { screenshotSink: sink });
      const result = await tools.dispatch('browser_take_screenshot', {});
      expect(sink).toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]), 'autotest-step');
      expect(result.ok).toBe(true);
      expect(result.text).toContain('upload-id-123');
      expect(result.data).toEqual(Buffer.from([1, 2, 3, 4]));
    });

    it('degrades gracefully (still ok) when the sink reports failure', async () => {
      const { page } = fakePage();
      const sink: ScreenshotSink = vi.fn().mockResolvedValue({ ok: false, note: 'network down' });
      const tools = new PlaywrightBrowserTools(page, undefined, { screenshotSink: sink });
      const result = await tools.dispatch('browser_take_screenshot', {});
      expect(result.ok).toBe(true); // non-fatal by design
      expect(result.text).toMatch(/staging it failed/);
      expect(result.text).not.toContain('screenshot_upload_id:');
    });

    it('degrades gracefully (still ok) when the sink throws', async () => {
      const { page } = fakePage();
      const sink: ScreenshotSink = vi.fn().mockRejectedValue(new Error('network down'));
      const tools = new PlaywrightBrowserTools(page, undefined, { screenshotSink: sink });
      const result = await tools.dispatch('browser_take_screenshot', {});
      expect(result.ok).toBe(true);
      expect(result.text).toMatch(/staging it failed: network down/);
    });
  });

  it('browser_wait_for waits for text when given', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_wait_for', { text: 'Welcome' });
    expect(page.getByText).toHaveBeenCalledWith('Welcome');
    expect(result.text).toBe('Text "Welcome" appeared');
  });

  it('browser_wait_for waits a fixed duration when no text is given', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_wait_for', { millis: 2000 });
    expect(page.waitForTimeout).toHaveBeenCalledWith(2000);
  });

  it('browser_wait_for defaults to 1000ms when neither text nor millis is given', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    await tools.dispatch('browser_wait_for', {});
    expect(page.waitForTimeout).toHaveBeenCalledWith(1000);
  });

  it('returns an explicit error for an unrecognized tool name', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_teleport', {});
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/Unknown browser tool/);
  });

  it('browser_console_messages returns real console entries, not always []', async () => {
    const { page, handlers } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    fireConsole(handlers, 'error', 'a real page error');
    const result = await tools.dispatch('browser_console_messages', {});
    expect(JSON.parse(result.text)).toEqual([{ type: 'error', text: 'a real page error', timestamp: expect.any(Number) }]);
  });

  it('browser_console_messages returns [] when nothing was logged since the last check', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_console_messages', {});
    expect(result.text).toBe('[]');
  });

  it('browser_network_requests returns real network entries, not always []', async () => {
    const { page, handlers } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    fireRequestFailed(handlers, 'POST', 'https://example.com/checkout');
    const result = await tools.dispatch('browser_network_requests', {});
    expect(JSON.parse(result.text)).toEqual([
      { method: 'POST', url: 'https://example.com/checkout', status: undefined, timestamp: expect.any(Number) },
    ]);
  });

  it('browser_console_messages only returns entries since the previous call, not the full history', async () => {
    const { page, handlers } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    fireConsole(handlers, 'log', 'first');
    await tools.dispatch('browser_console_messages', {});
    fireConsole(handlers, 'log', 'second');
    const result = await tools.dispatch('browser_console_messages', {});
    expect(JSON.parse(result.text)).toEqual([{ type: 'log', text: 'second', timestamp: expect.any(Number) }]);
  });

  it('browser_resize sets the viewport size of the currently selected tab', async () => {
    const { page } = fakePage();
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_resize', { width: 1280, height: 800 });
    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 800 });
    expect(result.text).toBe('Resized viewport to 1280x800');
  });

  it('browser_evaluate returns the real page.evaluate() result, unrestricted', async () => {
    const { page } = fakePage();
    (page.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue('Dashboard');
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_evaluate', { function: '() => document.title' });
    expect(page.evaluate).toHaveBeenCalledWith('() => document.title');
    expect(result.text).toBe('"Dashboard"');
  });

  it('browser_evaluate reports "undefined" rather than serializing it as null or throwing', async () => {
    const { page } = fakePage();
    (page.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const tools = new PlaywrightBrowserTools(page);
    const result = await tools.dispatch('browser_evaluate', { function: 'void 0' });
    expect(result.text).toBe('undefined');
  });

  describe('browser_tabs', () => {
    it('list reports a single tab, marked selected, before any tab is ever opened', async () => {
      const { page } = fakePage('https://example.com/start');
      const tools = new PlaywrightBrowserTools(page);
      const result = await tools.dispatch('browser_tabs', { action: 'list' });
      expect(result.text).toBe('0 (selected): https://example.com/start');
    });

    it('new opens a tab via the current page\'s context, selects it, and navigates it when url is given', async () => {
      const { page: page0 } = fakePage('https://example.com/start');
      const { page: page1 } = fakePage('https://example.com/new-tab');
      const newPage = vi.fn().mockResolvedValue(page1);
      (page0.context as ReturnType<typeof vi.fn>).mockReturnValue({ newPage });
      const tools = new PlaywrightBrowserTools(page0);

      const result = await tools.dispatch('browser_tabs', { action: 'new', url: 'https://example.com/new-tab' });
      expect(newPage).toHaveBeenCalled();
      expect(page1.goto).toHaveBeenCalledWith('https://example.com/new-tab', { waitUntil: 'domcontentloaded' });
      expect(result.text).toContain('index 1');

      // The new tab is now the target of every other browser_* op.
      await tools.dispatch('browser_navigate', { url: 'https://example.com/somewhere' });
      expect(page1.goto).toHaveBeenCalledWith('https://example.com/somewhere', { waitUntil: 'domcontentloaded' });
      expect(page0.goto).not.toHaveBeenCalled();
    });

    it('select switches which page every other browser_* op targets', async () => {
      const { page: page0 } = fakePage('https://example.com/start');
      const { page: page1 } = fakePage('https://example.com/new-tab');
      (page0.context as ReturnType<typeof vi.fn>).mockReturnValue({ newPage: vi.fn().mockResolvedValue(page1) });
      const tools = new PlaywrightBrowserTools(page0);
      await tools.dispatch('browser_tabs', { action: 'new' });

      await tools.dispatch('browser_tabs', { action: 'select', index: 0 });
      await tools.dispatch('browser_press_key', { key: 'Escape' });
      expect(page0.keyboard.press).toHaveBeenCalledWith('Escape');
      expect(page1.keyboard.press).not.toHaveBeenCalled();
    });

    it('select on an out-of-range index fails without changing the current selection', async () => {
      const { page } = fakePage();
      const tools = new PlaywrightBrowserTools(page);
      const result = await tools.dispatch('browser_tabs', { action: 'select', index: 5 });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/No tab at index/);
    });

    it('a tab switch invalidates refs from a snapshot taken on the previous tab', async () => {
      const { page: page0 } = fakePage();
      const { page: page1 } = fakePage();
      (page0.context as ReturnType<typeof vi.fn>).mockReturnValue({ newPage: vi.fn().mockResolvedValue(page1) });
      const tools = new PlaywrightBrowserTools(page0);
      await tools.dispatch('browser_snapshot', {}); // sees e1, e2 on page0
      await tools.dispatch('browser_tabs', { action: 'new' });
      await expect(tools.dispatch('browser_click', { ref: 'e2', label: 'Continue' })).rejects.toThrow(/Unknown ref "e2"/);
    });

    it('close removes a tab by index and falls back to another tab', async () => {
      const { page: page0 } = fakePage();
      const { page: page1 } = fakePage();
      (page0.context as ReturnType<typeof vi.fn>).mockReturnValue({ newPage: vi.fn().mockResolvedValue(page1) });
      const tools = new PlaywrightBrowserTools(page0);
      await tools.dispatch('browser_tabs', { action: 'new' }); // now on tab 1 (page1)

      const result = await tools.dispatch('browser_tabs', { action: 'close', index: 1 });
      expect(page1.close).toHaveBeenCalled();
      expect(result.text).toContain('Now on tab 0');

      const list = await tools.dispatch('browser_tabs', { action: 'list' });
      expect(list.text.split('\n')).toHaveLength(1);
    });

    it('close refuses to close the only remaining tab', async () => {
      const { page } = fakePage();
      const tools = new PlaywrightBrowserTools(page);
      const result = await tools.dispatch('browser_tabs', { action: 'close', index: 0 });
      expect(result.ok).toBe(false);
      expect(page.close).not.toHaveBeenCalled();
    });

    it('an unrecognized action is rejected explicitly', async () => {
      const { page } = fakePage();
      const tools = new PlaywrightBrowserTools(page);
      const result = await tools.dispatch('browser_tabs', { action: 'teleport' });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/Unknown browser_tabs action/);
    });
  });

  it('console evidence is tracked per tab — a new tab\'s console output does not leak into the original tab\'s deltas', async () => {
    const { page: page0, handlers: handlers0 } = fakePage();
    const { page: page1, handlers: handlers1 } = fakePage();
    (page0.context as ReturnType<typeof vi.fn>).mockReturnValue({ newPage: vi.fn().mockResolvedValue(page1) });
    const tools = new PlaywrightBrowserTools(page0);

    await tools.dispatch('browser_tabs', { action: 'new' }); // selected: page1
    fireConsole(handlers1, 'error', 'error on new tab');
    fireConsole(handlers0, 'log', 'log on original tab');

    const onNewTab = await tools.dispatch('browser_console_messages', {});
    expect(JSON.parse(onNewTab.text)).toEqual([{ type: 'error', text: 'error on new tab', timestamp: expect.any(Number) }]);

    await tools.dispatch('browser_tabs', { action: 'select', index: 0 });
    const onOriginalTab = await tools.dispatch('browser_console_messages', {});
    expect(JSON.parse(onOriginalTab.text)).toEqual([{ type: 'log', text: 'log on original tab', timestamp: expect.any(Number) }]);
  });
});
