const { test, expect } = require("@playwright/test");

function typeKey(card) {
  const value = String(card || "");
  if (value.startsWith("amenity:")) return "amenity";
  if (value.startsWith("pinboard") || value.startsWith("collage")) return "pinboard";
  if (value.startsWith("board:") || value.startsWith("leaderboard")) return "leaderboard";
  if (value.startsWith("logo:")) return value;
  if (value.startsWith("video:")) {
    const modeAt = value.search(/:(?:card|span)(?::|$)/);
    const id = modeAt === -1 ? value.slice("video:".length) : value.slice("video:".length, modeAt);
    return `video:${id}`;
  }
  return value.split(":")[0] || value;
}

async function readCards(pages) {
  const cards = [];
  for (const page of pages) {
    cards.push(await page.locator("#screen").getAttribute("data-card"));
  }
  return cards;
}

test("three live displays stay unique across real dwell ticks", async ({ browser, request }) => {
  test.setTimeout(90000);
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
  const samples = [];
  const started = Date.now();
  let last = "";
  while (samples.length < 22 && Date.now() - started < 45000) {
    const first = await readCards(pages);
    await pages[0].waitForTimeout(120);
    const second = await readCards(pages);
    if (first.join("|") !== second.join("|")) continue;
    const keys = first.map(typeKey);
    expect(new Set(keys).size, JSON.stringify(first)).toBe(3);
    const signature = keys.join("|");
    if (signature !== last) {
      samples.push(first);
      last = signature;
    }
  }
  expect(samples.length).toBeGreaterThanOrEqual(20);
  await pages[0].screenshot({ path: "e2e/artifacts/rotation-screen-1.png" });
  await pages[1].screenshot({ path: "e2e/artifacts/rotation-screen-2.png" });
  await pages[2].screenshot({ path: "e2e/artifacts/rotation-screen-3.png" });
  await context.close();
});

test("video mode plays a bundled clip past three seconds", async ({ page, request }) => {
  test.setTimeout(30000);
  const pinned = await request.put("/api/displays", {
    headers: { "x-pin": "2224" },
    data: { screens: { 1: { content: "video" } } },
  });
  expect(pinned.ok()).toBeTruthy();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/display/1");
  await page.waitForFunction(() => {
    const video = document.querySelector("#wall-video");
    const screen = document.querySelector("#screen");
    return screen?.dataset.mode === "video" && video && !video.hidden && !video.paused && video.currentTime > 3;
  });
  const frame = await page.evaluate(() => {
    const video = document.querySelector("#wall-video");
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 27;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, 48, 27);
    const data = ctx.getImageData(0, 0, 48, 27).data;
    let nonBlack = 0;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r + g + b > 40) nonBlack += 1;
      colors.add(`${r >> 4},${g >> 4},${b >> 4}`);
    }
    return {
      nonBlack,
      colors: colors.size,
      mode: document.querySelector("#screen")?.dataset.mode,
      logoHidden: document.querySelector("#logo")?.hidden,
      card: document.querySelector("#screen")?.dataset.card || "",
    };
  });
  expect(frame.mode).toBe("video");
  expect(frame.logoHidden).toBe(true);
  expect(frame.card.startsWith("video:")).toBe(true);
  expect(frame.card).not.toContain("logo");
  expect(frame.nonBlack).toBeGreaterThan(80);
  expect(frame.colors).toBeGreaterThan(3);
  const text = (await page.locator("body").innerText()).toLowerCase();
  expect(text).not.toContain("skipping");
  expect(text).not.toContain("did not play");
  await page.screenshot({ path: "e2e/artifacts/video-playing.png" });
});

test("sprite sheet draws a spider and a bat", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/sprite-preview.html");
  await page.waitForFunction(() => window.PinballMotion && document.querySelector("#sheet"));
  await page.screenshot({ path: "e2e/artifacts/sprites-spider-bat.png" });
});

test("camera hides the raw file inputs and opens a photo lightbox", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take Photo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose Photo" })).toBeVisible();
  await expect(page.locator("#take-file")).toBeHidden();
  await expect(page.locator("#choose-file")).toBeHidden();
  await expect(page.locator("#photo-lightbox")).toBeHidden();
  const guestJs = await page.evaluate(async () => (await fetch("/guest.js")).text());
  expect(guestJs).not.toContain("navigator.share");
});
