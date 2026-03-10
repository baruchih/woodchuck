import { test, expect } from '@playwright/test';

test.describe('Session Page - Mobile', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to sessions list
    await page.goto('/');

    // Wait for sessions to load — look for card-interactive elements
    await page.waitForSelector('.card-interactive', { timeout: 15000 });

    // Click the first session card
    const sessionCard = page.locator('.card-interactive').first();
    await sessionCard.click();

    // Wait for session page to load (xterm renders a canvas)
    await page.waitForSelector('.xterm', { timeout: 15000 });
  });

  test('mobile input bar is visible', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile-only test');

    // The MobileInputBar text input should be visible
    const inputBar = page.locator('input[placeholder="Type a message..."]');
    await expect(inputBar).toBeVisible({ timeout: 5000 });

    // The action toolbar buttons should be visible
    await expect(page.getByRole('button', { name: 'Enter' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Esc' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'C-c' })).toBeVisible();
  });

  test('mobile input bar stays visible after typing', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile-only test');

    const inputBar = page.locator('input[placeholder="Type a message..."]');
    await expect(inputBar).toBeVisible({ timeout: 5000 });

    // Type some text
    await inputBar.tap();
    await inputBar.fill('hello world');

    // Input bar should still be visible with the text
    await expect(inputBar).toBeVisible();
    await expect(inputBar).toHaveValue('hello world');

    // Input bar should be within the viewport
    const box = await inputBar.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      const viewportSize = page.viewportSize();
      expect(box.y + box.height).toBeLessThanOrEqual(viewportSize!.height);
      expect(box.y).toBeGreaterThanOrEqual(0);
    }
  });

  test('terminal xterm container exists and is visible', async ({ page }) => {
    const xterm = page.locator('.xterm');
    await expect(xterm).toBeVisible();

    // Canvas should be rendered (xterm uses canvas for rendering)
    const canvas = page.locator('.xterm canvas');
    expect(await canvas.count()).toBeGreaterThan(0);
  });

  test('terminal content does not rewrite while scrolled up', async ({ page }) => {
    // Get the xterm viewport (the scrollable div)
    const viewport = page.locator('.xterm-viewport');
    await expect(viewport).toBeVisible();

    // Check if there's scrollable content
    const scrollInfo = await viewport.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    }));

    if (scrollInfo.scrollHeight <= scrollInfo.clientHeight) {
      test.skip(true, 'Not enough content to scroll');
      return;
    }

    // Scroll to top
    await viewport.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(300);

    const scrollTopBefore = await viewport.evaluate((el) => el.scrollTop);
    expect(scrollTopBefore).toBe(0);

    // Wait for a content poll cycle (polls every 200ms-1s)
    await page.waitForTimeout(2500);

    // Scroll position should be preserved (write deferred while scrolled up)
    const scrollTopAfter = await viewport.evaluate((el) => el.scrollTop);
    expect(scrollTopAfter).toBe(0);
  });

  test('action buttons are clickable', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile-only test');

    // All action buttons should be present and clickable
    const buttons = ['Enter', 'Esc', 'C-c', 'Tab', 'A+', 'A-', 'Kill'];
    for (const name of buttons) {
      const btn = page.getByRole('button', { name, exact: true });
      await expect(btn).toBeVisible({ timeout: 3000 });
    }

    // Click Enter — should not crash
    await page.getByRole('button', { name: 'Enter', exact: true }).tap();
    await page.waitForTimeout(500);

    // Page should still be intact
    await expect(page.locator('.xterm')).toBeVisible();
  });
});
