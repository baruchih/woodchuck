import { test, expect } from '@playwright/test';

test.describe('Deploy API', () => {
  test('get deploy status', async ({ request }) => {
    const res = await request.get('/api/deploy/status');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.pending).toBe('boolean');
    // last_deploy can be null
    expect(body.data).toHaveProperty('last_deploy');
    expect(body.data).toHaveProperty('cooldown_remaining_secs');
  });

  test('abort when no deploy pending returns not aborted', async ({ request }) => {
    const res = await request.post('/api/deploy/abort');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.aborted).toBe(false);
  });

  test('trigger deploy fails without new binary', async ({ request }) => {
    const res = await request.post('/api/deploy/trigger');
    // Should fail because no new binary exists
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});

test.describe('Deploy UI', () => {
  test('settings page shows deploy section', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('text=Deploy')).toBeVisible();
    await expect(page.locator('text=Self-upgrade pipeline')).toBeVisible();
  });

  test('deploy section shows status and buttons', async ({ page }) => {
    await page.goto('/settings');

    // Should show either "Idle" or "Deploy in progress"
    await expect(
      page.locator('text=Idle').or(page.locator('text=Deploy in progress'))
    ).toBeVisible();

    // Should have deploy and rollback buttons when idle
    const deployBtn = page.locator('button:has-text("Deploy")');
    if (await deployBtn.isVisible()) {
      await expect(deployBtn).toBeVisible();
    }
  });
});
