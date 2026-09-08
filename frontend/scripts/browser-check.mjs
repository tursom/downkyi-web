import { chromium, expect } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

// Only this test supplies fixtures. Static assets are routed in-browser; no server is started.
const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "dist");
const artifacts = resolve(root, "test-results");
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
});
const contentTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};
const states = [
  "downloading",
  "queued",
  "resolving",
  "merging",
  "paused",
  "completed",
  "failed",
];
const errors = [];
let checks = 0;
try {
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 320, height: 740 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const fixtureImage = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#8bb2bb";
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "#eee8dc";
      ctx.fillRect(45, 30, 230, 120);
      ctx.fillStyle = "#283336";
      ctx.font = "22px sans-serif";
      ctx.fillText("TEST MEDIA", 90, 100);
      return canvas.toDataURL("image/png");
    });
    page.on("pageerror", (error) => errors.push(error.message));
    let hasTasks = false,
      authenticated = false,
      duplicate = false,
      apiError = false,
      qrStatus = "waiting";
    let createdBody;
    const initialDownloadDir = "/downloads/long-directory-name-for-responsive-layout-check";
    let settings = {
      concurrency: 2,
      cookie_configured: true,
      download_dir: initialDownloadDir,
      default_download_dir: initialDownloadDir,
    };
    let rejectDirectory = false;
    const tasks = states.map((status, index) => ({
      id: `test-${index}`,
      url: "https://www.bilibili.com/video/BVtest",
      title:
        index === 0
          ? "浏览器测试：这是用于验证手机端长标题的测试任务 BrowserLayoutCheckWithAnExtremelyLongUnbrokenTitle"
          : `浏览器测试任务 ${index + 1}`,
      thumbnail: "/test-cover.png",
      status,
      progress: status === "completed" ? 100 : 37.4,
      downloaded_bytes: 1024 ** 2 * 37,
      total_bytes: 1024 ** 2 * 100,
      speed: status === "downloading" ? 1024 ** 2 : null,
      eta: 63,
      error:
        status === "failed" ? "测试错误信息：无法下载视频，请重试。" : null,
      quality: "1080",
      mode: "video",
      codec: "avc",
      subtitles: true,
      cover: true,
      record_removed: false,
      files_deleted: false,
      source_key: `source-${index}`,
      download_dir: initialDownloadDir,
      created_at: "2026-01-01T12:00:00Z",
      updated_at: "2026-01-01T12:00:00Z",
    }));
    const preserved = {
      ...tasks[5],
      id: "preserved",
      title: "保留的输出文件",
      record_removed: true,
    };
    const entries = Array.from({ length: 6 }, (_, index) => ({
      id: `part-${index}`,
      title: `第 ${index + 1} 集：响应式布局和分 P 选择测试`,
      thumbnail: "/test-cover.png",
      duration: 125,
      url: `entry-${index}`,
      group: index < 4 ? "正片" : "花絮",
      available: index !== 5,
      error: index === 5 ? "尚未播出" : null,
      qualities: index === 4 ? [] : [2160, 1440, 1080, 720],
      codecs: ["avc", "hevc", "av1"],
      has_subtitles: index % 2 === 0,
    }));
    await page.route("https://downkyi.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body) => route.fulfill({ json: body });
      if (path === "/api/session") return json({ authenticated });
      if (path === "/api/login") {
        authenticated = true;
        return json({ authenticated });
      }
      if (path === "/api/logout") {
        authenticated = false;
        return json({ ok: true });
      }
      if (path === "/api/tasks" && route.request().method() === "POST") {
        createdBody = route.request().postDataJSON();
        if (duplicate)
          return route.fulfill({
            status: 409,
            json: { detail: "任务已存在，请检查下载队列" },
          });
        return json({ tasks: [tasks[1]] });
      }
      if (path === "/api/tasks")
        return apiError
          ? route.fulfill({ status: 503, json: { detail: "测试连接异常" } })
          : json({ tasks: hasTasks ? tasks : [] });
      if (path === "/api/library")
        return json({ tasks: hasTasks ? [tasks[5], preserved] : [] });
      if (path === "/api/system")
        return json({
          version: "test-version",
          yt_dlp_version: "test-version",
          ffmpeg: true,
          disk_total: 1024 ** 3 * 100,
          disk_free: 1024 ** 3 * 70,
          download_dir: settings.download_dir,
          active_tasks: hasTasks ? 4 : 0,
        });
      if (path === "/api/settings") {
        if (route.request().method() === "PATCH") {
          if (rejectDirectory) return route.fulfill({ status: 400, json: { detail: "目录不存在或不可写" } });
          settings = { ...settings, ...route.request().postDataJSON() };
        }
        return json(settings);
      }
      if (path === "/api/bilibili/account")
        return json({ logged_in: true, username: "测试账户", vip: true });
      if (path === "/api/bilibili/qr")
        return json({
          id: "qr-test",
          image: fixtureImage,
          url: "https://passport.bilibili.com/test",
          expires_in: 120,
        });
      if (path === "/api/bilibili/qr/qr-test/poll")
        return json({
          status: qrStatus,
          message: qrStatus === "waiting" ? "等待扫码" : "二维码已过期",
        });
      if (path === "/api/parse")
        return json({
          id: "parse-test",
          title: "用于浏览器验证的分 P 合集",
          thumbnail: "/test-cover.png",
          entries,
          truncated: true,
          warnings: ["部分资源不可用"],
        });
      if (path.endsWith("/files")) {
        if (route.request().method() === "DELETE") return json({ ok: true });
        return json({
          files: [
            {
              name: "下载文件名测试-ThisIsAnExtremelyLongUnbrokenFileNameToCheckWrapping.mp4",
              size: 1024,
              url: "/api/files/test.mp4",
            },
          ],
        });
      }
      if (path.startsWith("/api/tasks/") && route.request().method() === "POST")
        return json(tasks[0]);
      if (path.startsWith("/api/")) {
        errors.push(`Unexpected request: ${path}`);
        return route.fulfill({
          status: 404,
          json: { detail: "Unexpected fixture request" },
        });
      }
      if (path === "/test-cover.png")
        return route.fulfill({
          body: Buffer.from(fixtureImage.split(",")[1], "base64"),
          contentType: "image/png",
        });
      const file = resolve(dist, path === "/" ? "index.html" : path.slice(1));
      if (!file.startsWith(`${dist}/`)) return route.abort();
      try {
        return await route.fulfill({
          body: await readFile(file),
          contentType:
            contentTypes[extname(file)] || "application/octet-stream",
        });
      } catch {
        return route.fulfill({ status: 404, body: "Not found" });
      }
    });
    async function checkLayout(name) {
      await page.screenshot({
        path: resolve(artifacts, `${viewport.width}-${name}.png`),
        fullPage: true,
      });
      const overflowDetails = await page.evaluate(() => {
        if (document.documentElement.scrollWidth <= window.innerWidth)
          return [];
        return Array.from(document.querySelectorAll("body *"))
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.right > window.innerWidth + 1 &&
              !element.closest(".table-scroll, .tabs")
            );
          })
          .map((element) => ({
            tag: element.tagName,
            class: element.className,
            right: element.getBoundingClientRect().right,
          }));
      });
      if (overflowDetails.length) console.log(name, overflowDetails);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        ),
        `${viewport.width}px ${name} page overflow`,
      ).toBe(false);
      expect(
        await page
          .locator('[role="dialog"]')
          .evaluateAll((elements) =>
            elements.some(
              (element) => element.scrollWidth > element.clientWidth + 1,
            ),
          ),
        `${viewport.width}px ${name} dialog overflow`,
      ).toBe(false);
      checks += 1;
    }
    async function navigate(name) {
      if (viewport.width <= 700) {
        await page.getByRole("button", { name: "打开导航" }).click();
        await expect(page.locator("#root")).toHaveJSProperty("inert", true);
        await checkLayout("drawer");
        await page.getByRole("dialog").getByRole("button", { name }).click();
        await expect(page.locator("#root")).toHaveJSProperty("inert", false);
      } else
        await page
          .getByRole("navigation", { name: "主导航" })
          .getByRole("button", { name })
          .click();
    }
    await page.goto("https://downkyi.test/");
    await expect(page.getByLabel("访问令牌")).toBeVisible();
    await checkLayout("login");
    await page.getByLabel("访问令牌").fill("browser-test-token");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByText("还没有下载任务")).toBeVisible();
    await checkLayout("empty");
    hasTasks = true;
    await page.getByRole("button", { name: "刷新任务" }).click();
    await expect(page.locator(".task-table tbody tr")).toHaveCount(7);
    if (viewport.width > 700) {
      const nav = await page.locator(".app-nav").boundingBox(),
        main = await page.locator("#main").boundingBox();
      expect(nav.height).toBe(70);
      expect(main.x).toBe(0);
      expect(main.width).toBe(viewport.width);
      expect(
        (await page.locator(".task-table tbody tr").first().boundingBox())
          .height,
      ).toBeLessThanOrEqual(80);
    }
    await expect(page.locator(".table-title img").first()).toHaveJSProperty(
      "naturalWidth",
      320,
    );
    await checkLayout("tasks");
    apiError = true;
    await page.getByRole("button", { name: "刷新任务" }).click();
    await expect(page.getByRole("alert")).toContainText("测试连接异常");
    await checkLayout("error");
    apiError = false;
    await page.getByRole("button", { name: "刷新任务" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page
      .locator("#main")
      .getByRole("button", { name: "新建下载" })
      .click();
    await checkLayout("parse-input");
    await page.getByLabel("视频、合集、番剧链接或 BV / AV 号").fill("BVtest");
    await page.getByRole("button", { name: "解析", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认规格" })).toBeVisible();
    await expect(page.locator(".workflow-steps li")).toHaveCount(3);
    const pickerBox = await page.locator(".entry-picker").boundingBox(),
      specBox = await page.locator(".download-specs").boundingBox();
    if (viewport.width > 700) {
      expect(specBox.x).toBeGreaterThan(pickerBox.x);
      expect(specBox.y).toBe(pickerBox.y);
    } else expect(specBox.y).toBeGreaterThan(pickerBox.y);
    await checkLayout("parse-selection");
    await page.getByLabel("画质", { exact: true }).selectOption("1440");
    await page.getByLabel("视频编码").selectOption("av1");
    await page.getByLabel("下载字幕").check();
    await page.getByLabel("下载封面").uncheck();
    await page.getByRole("button", { name: "确认规格" }).click();
    await expect(page.getByText("准备添加 4 个下载任务")).toBeVisible();
    await checkLayout("parse-review");
    duplicate = true;
    await page.getByRole("button", { name: "加入队列 (4)" }).click();
    await expect(page.getByRole("alert")).toContainText("任务已存在");
    await checkLayout("duplicate");
    duplicate = false;
    await page.getByRole("button", { name: "加入队列 (4)" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(createdBody).toEqual({
      parse_id: "parse-test",
      entry_ids: ["part-0", "part-1", "part-2", "part-3"],
      quality: "1440",
      mode: "video",
      codec: "av1",
      cover: false,
      subtitles: true,
    });
    await page
      .getByRole("button", { name: "任务详情：浏览器测试任务 4" })
      .click();
    await expect(page.locator(".stage-timeline .current")).toHaveText(
      "4合并校验",
    );
    await checkLayout("detail");
    await page.keyboard.press("Escape");
    await navigate(/^已完成/);
    await expect(page.getByText("记录已移除 · 文件保留")).toBeVisible();
    await checkLayout("library");
    await page
      .getByRole("button", { name: "查看文件：保留的输出文件" })
      .click();
    await expect(
      page.getByRole("link", { name: /^下载 下载文件名测试/ }),
    ).toBeVisible();
    await checkLayout("files");
    await page.getByRole("button", { name: "删除文件", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "永久删除文件" }),
    ).toBeDisabled();
    await checkLayout("file-delete");
    await page.keyboard.press("Escape");
    await navigate("偏好设置");
    await expect(page.getByRole("heading", { name: "下载设置" })).toBeVisible();
    await expect(page.getByLabel("下载目录", { exact: true })).toHaveValue(initialDownloadDir);
    await checkLayout("settings");
    const newDownloadDir = "/export/long-existing-directory-for-responsive-layout-check";
    await page.getByLabel("下载目录", { exact: true }).fill(newDownloadDir);
    rejectDirectory = true;
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(page.getByRole("alert")).toContainText("目录不存在或不可写");
    await expect(page.getByLabel("下载目录", { exact: true })).toHaveValue(newDownloadDir);
    await checkLayout("settings-directory-error");
    rejectDirectory = false;
    await page.getByRole("button", { name: "保存设置" }).click();
    await expect(page.getByText("下载设置已保存")).toBeVisible();
    await expect(page.getByRole("button", { name: "保存设置" })).toBeDisabled();
    await checkLayout("settings-directory-saved");
    await navigate(/^下载队列/);
    await expect(page.getByText(newDownloadDir, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "任务详情：浏览器测试任务 4" }).click();
    await expect(page.getByText(`${initialDownloadDir}/test-3`, { exact: true })).toBeVisible();
    await checkLayout("detail-pinned-directory");
    await page.keyboard.press("Escape");
    await navigate("偏好设置");
    await expect(page.getByLabel("下载目录", { exact: true })).toHaveValue(newDownloadDir);
    await page.getByRole("button", { name: "哔哩哔哩账户" }).click();
    await expect(page.getByLabel("Netscape Cookie 文本")).toBeVisible();
    await checkLayout("account");
    await page.getByRole("button", { name: "扫码登录" }).click();
    await expect(page.getByAltText("哔哩哔哩登录二维码")).toHaveJSProperty(
      "naturalWidth",
      320,
    );
    await checkLayout("qr");
    qrStatus = "expired";
    await expect(
      page.getByRole("button", { name: "重新获取二维码" }),
    ).toBeVisible({ timeout: 6000 });
    await checkLayout("qr-expired");
    await page.keyboard.press("Escape");
    await navigate("服务器");
    await expect(page.getByRole("heading", { name: "运行环境" })).toBeVisible();
    await checkLayout("system");
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByLabel("访问令牌")).toBeVisible();
    await context.close();
  }
  expect(errors).toEqual([]);
  console.log(
    `${checks} B-layout browser checks passed across 1440, 768, 390 and 320px; no page errors; no server started.`,
  );
} finally {
  await browser.close();
}
