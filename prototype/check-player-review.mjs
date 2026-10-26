import { chromium, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.env.PROTOTYPE_URL || 'http://127.0.0.1:8510';
const screenshots = '/tmp/downkyi-player-review';
mkdirSync(screenshots, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const results = [];
try {
  for (const width of [1440, 390]) {
    for (const mode of ['cinema', 'detail']) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/')) errors.push(`Unexpected API call: ${request.url()}`);
      });
      await page.goto(`${base}/optimization.html?variant=C&watch=1&player=${mode}`);
      const dialog = page.getByRole('dialog');
      const video = page.locator('video');
      await expect(dialog).toBeVisible();
      await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
      expect(await video.evaluate(element => element.duration)).toBeCloseTo(20, 0);
      expect(await video.evaluate(element => element.videoWidth)).toBe(1280);
      await expect(dialog).toHaveClass(new RegExp(`player-review--${width <= 820 ? 'mobile' : mode}`));
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `${screenshots}/${mode}-${width}.png`, fullPage: false });

      await dialog.getByRole('button', { name: '播放', exact: true }).click();
      await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(0.2);
      await dialog.getByRole('button', { name: '暂停', exact: true }).click();
      expect(await video.evaluate(element => element.paused)).toBe(true);
      const seek = dialog.getByRole('slider', { name: '播放进度', exact: true });
      const bounds = await seek.boundingBox();
      await seek.click({ position: { x: bounds.width * 0.5, y: bounds.height * 0.5 } });
      await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(8);
      const before = await video.evaluate(element => element.currentTime);
      if (width > 820) {
        await dialog.getByRole('button', { name: mode === 'cinema' ? '详情模式' : '影院模式', exact: true }).click();
      } else {
        await expect(dialog.getByRole('group', { name: '观看模式' })).toHaveCount(0);
        await dialog.getByRole('tab', { name: '详情与附件', exact: true }).click();
        await expect(dialog.getByRole('tabpanel', { name: '详情与附件', exact: true })).toBeVisible();
        await expect(dialog.getByRole('switch', { name: '自动连播', exact: true })).not.toBeVisible();
        await page.screenshot({ path: `${screenshots}/mobile-details-${width}.png`, fullPage: false });
        await dialog.getByRole('tab', { name: '详情与附件', exact: true }).press('ArrowLeft');
        await expect(dialog.getByRole('tab', { name: /选集/ })).toBeFocused();
        await expect(dialog.getByRole('tab', { name: /选集/ })).toHaveAttribute('aria-selected', 'true');
      }
      expect(await video.evaluate(element => element.currentTime)).toBeCloseTo(before, 1);
      await dialog.getByRole('combobox', { name: '播放速度', exact: true }).selectOption('2');
      expect(await video.evaluate(element => element.playbackRate)).toBe(2);
      await dialog.getByRole('slider', { name: '音量', exact: true }).press('Home');
      expect(await video.evaluate(element => element.volume)).toBe(0);

      const subtitle = dialog.getByRole('button', { name: '字幕', exact: true });
      const previousMode = await video.evaluate(element => element.textTracks[0].mode);
      await subtitle.click();
      await expect.poll(() => video.evaluate(element => element.textTracks[0].mode)).not.toBe(previousMode);
      await video.focus();
      const beforeKey = await video.evaluate(element => element.currentTime);
      await video.press('ArrowRight');
      expect(await video.evaluate(element => element.currentTime)).toBeCloseTo(beforeKey + 5, 0);
      await video.press('Space');
      await expect.poll(() => video.evaluate(element => element.paused)).toBe(false);
      await video.press('Space');
      await expect.poll(() => video.evaluate(element => element.paused)).toBe(true);
      await dialog.getByRole('button', { name: '全屏', exact: true }).click();
      await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
      await page.keyboard.press('Escape');
      await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: '下一集', exact: true }).click();
      await expect(dialog.getByRole('heading', { level: 1 })).toContainText('东京漫步');
      await dialog.getByRole('switch', { name: '自动连播', exact: true }).click();
      await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
      await video.evaluate(element => { element.currentTime = element.duration - 0.3; });
      await dialog.getByRole('button', { name: '播放', exact: true }).click();
      await expect(dialog.getByRole('heading', { level: 1 })).toContainText('抬头之后');
      await expect.poll(() => video.evaluate(element => element.paused)).toBe(false);
      await dialog.getByRole('button', { name: '暂停', exact: true }).click();
      await dialog.getByRole('button', { name: '标记已看', exact: true }).click();
      await dialog.getByRole('button', { name: '返回媒体库', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
      await expect(page.locator('.media-card').filter({ hasText: '已看完' })).toHaveCount(2);
      expect(errors).toEqual([]);
      results.push({ mode, width, passed: true });
      await page.close();
    }
  }
  // Preference survives reopen, reload and a new tab. Explicit review links are
  // temporary overrides, and mobile layout never rewrites the desktop choice.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${base}/optimization.html?variant=C&watch=1`);
  const dialog = page.getByRole('dialog');
  const video = page.locator('video');
  await expect(dialog).toHaveClass(/player-review--cinema/);
  await expect.poll(() => video.evaluate(element => element.readyState)).toBeGreaterThanOrEqual(2);
  await dialog.getByRole('button', { name: '下一集', exact: true }).click();
  await dialog.getByRole('button', { name: '标记已看', exact: true }).click();
  await dialog.getByRole('combobox', { name: '播放速度' }).selectOption('1.5');
  await dialog.getByRole('slider', { name: '音量', exact: true }).press('Home');
  await dialog.getByRole('button', { name: '字幕', exact: true }).click();
  await dialog.getByRole('switch', { name: '自动连播' }).click();
  await dialog.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(() => video.evaluate(element => element.currentTime)).toBeGreaterThan(0.2);
  await video.evaluate(element => { window.reviewVideoIdentity = element; });
  await dialog.getByRole('button', { name: '详情模式', exact: true }).click();
  expect(await page.evaluate(() => document.querySelector('video') === window.reviewVideoIdentity)).toBe(true);
  expect(await video.evaluate(element => ({ paused: element.paused, rate: element.playbackRate, volume: element.volume, subtitles: element.textTracks[0].mode }))).toEqual({ paused: false, rate: 1.5, volume: 0, subtitles: 'showing' });
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  const savedTime = await video.evaluate(element => element.currentTime);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toHaveClass(/player-review--mobile/);
  await dialog.getByRole('tab', { name: '详情与附件' }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(dialog).toHaveClass(/player-review--detail/);
  expect(await page.evaluate(() => document.querySelector('video') === window.reviewVideoIdentity)).toBe(true);
  expect(await video.evaluate(element => element.currentTime)).toBeCloseTo(savedTime, 1);
  await dialog.getByRole('button', { name: '返回媒体库' }).click();
  expect(new URL(page.url()).searchParams.has('player')).toBe(false);
  expect(new URL(page.url()).searchParams.has('watch')).toBe(false);
  await page.getByRole('button', { name: '继续观看', exact: true }).click();
  await expect(dialog).toHaveClass(/player-review--detail/);
  await expect(dialog.getByRole('heading', { level: 1 })).toContainText('东京漫步');
  await expect(dialog.getByRole('button', { name: '标记已看', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '返回媒体库' }).click();
  await page.reload();
  await page.getByRole('button', { name: '继续观看', exact: true }).click();
  await expect(dialog).toHaveClass(/player-review--detail/);
  const nextTab = await context.newPage();
  await nextTab.goto(`${base}/optimization.html?variant=C&watch=1&player=cinema`);
  await expect(nextTab.getByRole('dialog')).toHaveClass(/player-review--cinema/);
  await nextTab.goto(`${base}/optimization.html?variant=C&watch=1`);
  await expect(nextTab.getByRole('dialog')).toHaveClass(/player-review--detail/);
  await context.close();
  results.push({ preferencePersistence: true, mobileResizePreservesVideo: true, reopenPreservesSelection: true });

  const denied = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const deniedErrors = [];
  denied.on('pageerror', error => deniedErrors.push(error.message));
  await denied.addInitScript(() => {
    for (const method of ['getItem', 'setItem']) Object.defineProperty(Storage.prototype, method, { value() { throw new DOMException('Storage unavailable', 'SecurityError'); } });
  });
  await denied.goto(`${base}/optimization.html?variant=C&watch=1`);
  await expect(denied.getByRole('dialog')).toHaveClass(/player-review--cinema/);
  await denied.getByRole('button', { name: '详情模式', exact: true }).click();
  await expect(denied.getByRole('dialog')).toHaveClass(/player-review--detail/);
  expect(deniedErrors).toEqual([]);
  await denied.close();
  results.push({ unavailableStorageFallback: true });
  console.log(JSON.stringify({ results, screenshots }, null, 2));
} finally {
  await browser.close();
}
