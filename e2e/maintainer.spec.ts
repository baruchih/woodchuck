import { test, expect } from '@playwright/test';

test.describe('Maintainer API', () => {
  test('get maintainer status', async ({ request }) => {
    const res = await request.get('/api/maintainer/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.session_id).toBe('woodchuck-maintainer');
    expect(typeof body.data.ralph_active).toBe('boolean');
    expect(typeof body.data.ralph_paused).toBe('boolean');
    expect(typeof body.data.inbox_count).toBe('number');
    expect(Array.isArray(body.data.inbox_items)).toBe(true);
  });

  test('submit inbox item via API', async ({ request }) => {
    const res = await request.post('/api/maintainer/inbox', {
      data: {
        source: 'e2e-test',
        type: 'suggestion',
        message: 'E2E test suggestion - please ignore',
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.filename).toContain('e2e-test');
    expect(body.data.filename).toEndWith('.md');
  });

  test('inbox count increases after submission', async ({ request }) => {
    // Get initial count
    const before = await request.get('/api/maintainer/status');
    const beforeCount = (await before.json()).data.inbox_count;

    // Submit an item
    await request.post('/api/maintainer/inbox', {
      data: {
        source: 'e2e-count-test',
        type: 'bug',
        message: 'E2E count test - please ignore',
      },
    });

    // Verify count increased
    const after = await request.get('/api/maintainer/status');
    const afterCount = (await after.json()).data.inbox_count;
    expect(afterCount).toBeGreaterThan(beforeCount);
  });

  test('pause and resume maintainer ralph loop', async ({ request }) => {
    // Pause
    const pauseRes = await request.post('/api/maintainer/pause');
    expect(pauseRes.ok()).toBeTruthy();

    // Check status shows paused
    const statusRes = await request.get('/api/maintainer/status');
    const status = (await statusRes.json()).data;
    if (status.ralph_active) {
      expect(status.ralph_paused).toBe(true);
    }

    // Resume
    const resumeRes = await request.post('/api/maintainer/resume');
    expect(resumeRes.ok()).toBeTruthy();

    // Check status shows not paused
    const statusRes2 = await request.get('/api/maintainer/status');
    const status2 = (await statusRes2.json()).data;
    if (status2.ralph_active) {
      expect(status2.ralph_paused).toBe(false);
    }
  });
});

test.describe('Maintainer UI', () => {
  test('settings page shows maintainer section', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('text=Maintainer')).toBeVisible();
    await expect(page.locator('text=Self-healing agent')).toBeVisible();
  });

  test('settings page shows inbox section with send button', async ({ page }) => {
    await page.goto('/settings');

    // Should show inbox section
    await expect(page.locator('text=Inbox')).toBeVisible();

    // Should have the issue submission input
    const input = page.locator('input[placeholder*="Report an issue"]');
    await expect(input).toBeVisible();

    // Type a message and verify send button becomes enabled
    await input.fill('Test issue from Playwright');
    const sendBtn = page.locator('button:has-text("Send")');
    await expect(sendBtn).toBeEnabled();
  });

  test('submit issue via settings UI', async ({ page }) => {
    await page.goto('/settings');

    const input = page.locator('input[placeholder*="Report an issue"]');
    await input.fill('Playwright E2E test issue');

    const sendBtn = page.locator('button:has-text("Send")');
    await sendBtn.click();

    // Input should be cleared after successful send
    await expect(input).toHaveValue('');
  });

  test('terminal toggle button works', async ({ page }) => {
    await page.goto('/settings');

    // Look for Terminal button (only visible if maintainer is available)
    const terminalBtn = page.locator('button:has-text("Terminal")');

    // If maintainer is available, test the toggle
    if (await terminalBtn.isVisible()) {
      await terminalBtn.click();
      // Should show a pre element with terminal output
      await expect(page.locator('pre')).toBeVisible();

      // Button should now say "Hide"
      const hideBtn = page.locator('button:has-text("Hide")');
      await expect(hideBtn).toBeVisible();

      // Click hide
      await hideBtn.click();
      await expect(page.locator('pre')).not.toBeVisible();
    }
  });
});
