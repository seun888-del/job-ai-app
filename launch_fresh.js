const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  const app = await electron.launch({ args: [path.join(__dirname, 'main.js')] });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    localStorage.removeItem('welcome_seen');
    localStorage.removeItem('tour_complete');
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  console.log('App open — welcome modal showing. Interact with it now.');
  await new Promise(() => {});
})();
