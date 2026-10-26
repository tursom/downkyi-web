import { chromium, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.env.PROTOTYPE_URL || 'http://127.0.0.1:8510';
const screenshots = '/tmp/downkyi-optimization-screenshots';
mkdirSync(screenshots, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const results = [];
try {
  for (const width of [1440, 390]) {
    for (const variant of ['A', 'B', 'C']) {
      const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/')) errors.push(`Unexpected API request: ${request.url()}`);
      });
      const go = async label => page.getByRole('navigation', { name: '场景导航' }).getByRole('button', { name: label }).click();
      const shot = async name => {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${screenshots}/${variant}-${name}-${width}.png`, fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      };
      await page.goto(`${base}/optimization.html?variant=${variant}`);
      await expect(page.locator(`.optimization.variant-${variant}`)).toBeVisible();
      await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
      await shot('home');
      for (const [label, name] of [['任务', 'tasks'], ['大合集', 'collection'], ['订阅', 'subscriptions'], ['空间', 'storage'], ['媒体库', 'library'], ['偏好设置', 'settings']]) {
        await go(label);
        await shot(name);
      }
      if (variant === 'A') {
        await go('任务');
        await page.getByLabel('全选当前页任务').check();
        await page.getByRole('button', { name: '批量暂停', exact: true }).click();
        await expect(page.locator('.task').filter({ hasText: '已暂停' })).toHaveCount(4);
        await page.getByRole('button', { name: '批量恢复', exact: true }).click();
        await expect(page.locator('.task').filter({ hasText: '下载中' })).toHaveCount(4);
        await page.getByRole('button', { name: '补下载附件', exact: true }).click();
        await expect(page.locator('.task').filter({ hasText: '全部完成' })).toHaveCount(1);
        await go('大合集');
        await expect(page.locator('.collection-item')).toHaveCount(50);
        await page.getByRole('button', { name: '加载下一批（50 条）', exact: true }).click();
        await expect(page.locator('.collection-item')).toHaveCount(100);
        await page.getByLabel('全选已显示合集条目').check();
        await page.getByRole('button', { name: '仅解析所选（100）', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await shot('queue-confirm');
        await page.getByRole('button', { name: '取消确认，保留选择', exact: true }).click();
        await expect(page.locator('.collection-item input:checked')).toHaveCount(100);
        await page.getByRole('button', { name: '仅解析所选（100）', exact: true }).click();
        await page.getByRole('button', { name: '确认入队（100 条）', exact: true }).click();
        await expect(page.locator('.collection-item input:disabled')).toHaveCount(100);
        await go('任务');
        await expect(page.locator('.task')).toHaveCount(10);
        await expect(page.getByLabel('任务分页')).toContainText('共 106 项');
        const firstTitle = await page.locator('.task h3').first().innerText();
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        expect(await page.locator('.task h3').first().innerText()).not.toBe(firstTitle);
        await page.getByRole('region', { name: '选择布局方案' }).getByRole('button').nth(1).click();
        await expect(page.locator('.optimization.variant-B')).toBeVisible();
        await expect(page.getByLabel('任务分页')).toContainText('共 106 项');
        await page.getByRole('region', { name: '选择布局方案' }).getByRole('button').first().click();
        await go('空间');
        await page.getByLabel('清理 过期临时片段').check();
        await page.getByRole('button', { name: '预览清理（1 项）', exact: true }).click();
        await expect(page.getByRole('button', { name: '确认清理', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: '取消清理', exact: true }).click();
        await expect(page.getByLabel('清理 过期临时片段')).toBeChecked();
        await page.getByRole('button', { name: '预览清理（1 项）', exact: true }).click();
        await page.getByLabel('我已核对清理对象和路径').check();
        await shot('cleanup-confirm');
        await page.getByRole('button', { name: '确认清理', exact: true }).click();
        await expect(page.locator('.disk').first()).toContainText('11.6');
        await go('订阅');
        const sub = page.locator('.subscription').first();
        await sub.getByRole('button', { name: '手动检查', exact: true }).click();
        await expect(sub.locator('.subscription-result')).toContainText('2');
        await sub.getByRole('combobox').selectOption('自动入队');
        await sub.getByRole('button', { name: '手动检查', exact: true }).click();
        await go('任务');
        await expect(page.getByLabel('任务分页')).toContainText('共 108 项');
        await go('媒体库');
        await page.getByRole('button', { name: '继续观看', exact: true }).click();
        await page.getByRole('button', { name: '下一集', exact: true }).click();
        await expect(page.getByRole('dialog').getByRole('heading', { level: 1 })).toContainText('东京漫步');
        await page.getByRole('dialog').getByRole('button', { name: '标记已看', exact: true }).click();
        await shot('player');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await go('偏好设置');
        await page.getByLabel('自动重试次数', { exact: true }).fill('2');
        await page.getByLabel('磁盘保留阈值（GiB）', { exact: true }).fill('8');
        await page.getByRole('radio', { name: /媒体优先/ }).check();
        await page.getByRole('button', { name: '保存偏好设置', exact: true }).click();
        await expect(page.locator('.settings-footer')).toContainText('2 次重试 / 8 GiB / 媒体优先');
      }
      expect(errors).toEqual([]);
      results.push({ variant, width, passed: true });
      await page.close();
    }
  }
  console.log(JSON.stringify({ results, screenshots }, null, 2));
} finally {
  await browser.close();
}
