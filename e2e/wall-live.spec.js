const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const clipPath = path.join(__dirname, "fixtures", "wall-clip.mp4");

async function cardKeys(pages) {
  const keys = [];
  for (const page of pages) {
    keys.push(await page.locator("#screen").getAttribute("data-card"));
  }
  return keys;
}

test("auto rotation advances every dwell and keeps the three screens different", async ({ browser, request }) => {
  test.setTimeout(60000);
  const reset = await request.put("/api/displays", {
    headers: { "x-pin": "2224" },
    data: {
      screens: {
        1: { content: "rotation" },
        2: { content: "rotation" },
        3: { content: "rotation" },
      },
    },
  });
  expect(reset.ok()).toBeTruthy();
  const context = await browser.newContext();
  await context.clock.install({ time: Date.now() });
  const pages = [];
  for (const slot of [1, 2, 3]) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/display/${slot}`);
    pages.push(page);
  }
  await pages[0].waitForFunction(() => {
    const card = document.querySelector("#screen")?.dataset.card;
    return card && card !== "off";
  });
  const seen = [];
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const keys = await cardKeys(pages);
    expect(keys.every(Boolean), JSON.stringify(keys)).toBeTruthy();
    expect(new Set(keys).size, JSON.stringify(keys)).toBe(3);
    if (seen.length) {
      for (let i = 0; i < 3; i += 1) expect(keys[i]).not.toBe(seen[seen.length - 1][i]);
    }
    seen.push(keys);
    await context.clock.fastForward(30_000);
    await pages[0].waitForFunction((previous) => document.querySelector("#screen")?.dataset.card !== previous, keys[0]);
  }
  await context.close();
});

test("the video screen plays a local clip and never shows skip text", async ({ page, request }) => {
  test.setTimeout(60000);
  expect(fs.existsSync(clipPath)).toBeTruthy();
  const clip = fs.readFileSync(clipPath);
  const uploaded = await request.post("/api/media", {
    headers: {
      "x-pin": "2224",
      "content-type": "video/mp4",
      "x-filename": "wall-clip.mp4",
      "x-title": "Wall clip",
      "x-folder": "library",
      "x-in-rotation": "true",
      "x-loop": "true",
    },
    data: clip,
  });
  expect(uploaded.ok()).toBeTruthy();
  const body = await uploaded.json();
  const video = (body.media?.videos || []).find((item) => item.title === "Wall clip");
  expect(video?.id).toBeTruthy();
  const partial = await request.get(`/media/videos/${video.id}`, {
    headers: { Range: "bytes=0-15" },
  });
  expect(partial.status()).toBe(206);
  expect(partial.headers()["content-range"] || "").toContain("bytes 0-15/");
  const pinned = await request.put("/api/displays", {
    headers: { "x-pin": "2224" },
    data: { screens: { 1: { content: "video" } } },
  });
  expect(pinned.ok()).toBeTruthy();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/display/1");
  await page.waitForFunction(() => {
    const videoEl = document.querySelector("#wall-video");
    return videoEl && !videoEl.hidden && videoEl.readyState >= 2 && videoEl.currentTime > 0.2;
  });
  const text = await page.locator("body").innerText();
  expect(text.toLowerCase()).not.toContain("skipping");
  expect(text.toLowerCase()).not.toContain("did not play");
  await expect(page.locator("#video-fallback")).toBeHidden();
});

test("sprite sheet draws a spider and a bat", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/sprite-preview.html");
  await page.waitForFunction(() => window.PinballMotion && document.querySelector("#sheet"));
  await page.screenshot({ path: "e2e/artifacts/sprites-spider-bat.png" });
});

test("camera hides the raw file inputs", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take Photo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose Photo" })).toBeVisible();
  await expect(page.locator("#take-file")).toBeHidden();
  await expect(page.locator("#choose-file")).toBeHidden();
});
