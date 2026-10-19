import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] || process.env.ARBET_URL || 'https://inr.arbet.club/live/soccer';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultWindowsEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const executablePath = process.env.ARBET_BROWSER_PATH || (process.platform === 'win32' ? defaultWindowsEdge : undefined);

const browser = await chromium.launch({
  headless: process.env.HEADLESS !== 'false',
  executablePath,
  args: ['--disable-notifications'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const networkUrls = new Set();
  const marketResponse = page.waitForResponse(
    (response) => response.url().includes('/market-odds-live/v1/list-primary-markets'),
    { timeout: 30_000 },
  ).catch(() => null);
  page.on('response', (response) => {
    const responseUrl = response.url();
    if (/api|sport|match|event|market|odds|widget/i.test(responseUrl)) networkUrls.add(responseUrl);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6_000);
  const frameTexts = [];
  for (const frame of page.frames()) {
    try {
      frameTexts.push(`\n\n===== FRAME: ${frame.url()} =====\n${await frame.locator('body').innerText()}`);
    } catch {}
  }
  const bodyText = frameTexts.join('');
  const outputDir = path.join(root, 'work');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, 'arbet-network.txt'), [...networkUrls].join('\n'));
  const marketResponseResult = await marketResponse;
  if (marketResponseResult) {
    await fs.writeFile(path.join(outputDir, 'arbet-live-list-request.txt'), marketResponseResult.request().postData() || '');
    await fs.writeFile(path.join(outputDir, 'arbet-live-list.json'), await marketResponseResult.text());
  }
  await fs.writeFile(path.join(outputDir, 'arbet-page-text.txt'), bodyText);
  await fs.writeFile(path.join(outputDir, 'arbet-page.html'), await page.content());
  await page.screenshot({ path: path.join(outputDir, 'arbet-page.png'), fullPage: true });
  console.log(`Title: ${await page.title()}`);
  console.log(`URL: ${page.url()}`);
  console.log(`Visible text characters: ${bodyText.length}`);
  console.log('\nNetwork URLs:');
  console.log([...networkUrls].join('\n'));
  console.log(bodyText.slice(0, 15000));
  console.log('Saved full page text and screenshot in work/.');
} finally {
  await browser.close();
}
