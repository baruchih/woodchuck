import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'https://localhost:1212',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'Mobile Safari',
      use: {
        ...devices['iPhone 13'],
        hasTouch: true,
      },
    },
    {
      name: 'Desktop Chrome',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
