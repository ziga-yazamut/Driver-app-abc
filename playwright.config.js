// Tests. In CI: npx playwright install --with-deps chromium
// mockup: the clickable mockup. app: the real app against test/devserver.mjs (a local stand-in for Netlify + Supabase).
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  timeout: 30000,
  reporter: [['list']],
  use: {
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'mockup', testDir: 'mockup/tests' },
    { name: 'app', testDir: 'test', testMatch: /.*\.spec\.js/, use: { baseURL: 'http://localhost:8898' } },
  ],
  webServer: { command: 'node test/devserver.mjs 8898', url: 'http://localhost:8898/api/status', reuseExistingServer: false, timeout: 20000 },
});
