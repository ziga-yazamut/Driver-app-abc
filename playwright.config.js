// בדיקות ההדמיה. ב-CI: npx playwright install --with-deps chromium
const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: 'mockup/tests',
  timeout: 30000,
  reporter: [['list']],
  use: {
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
});
