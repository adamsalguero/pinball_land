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
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/sprite-preview.html");
  await page.waitForFunction(() => window.__sprites && window.PinballMotion);
  const silk = await page.evaluate(() => {
    const canvas = document.querySelector("#sheet");
    const ctx = canvas.getContext("2d");
    const spider = window.__sprites.spiders[0];
    const top = ctx.getImageData(spider.x, 1, 1, 1).data;
    const mid = ctx.getImageData(spider.x, Math.round(spider.y / 2), 1, 1).data;
    const background = ctx.getImageData(20, 20, 1, 1).data;
    const differs = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 24;
    return { topReaches: differs(top, background), midReaches: differs(mid, background) };
  });
  expect(silk.topReaches).toBe(true);
  expect(silk.midReaches).toBe(true);
  await page.screenshot({ path: "e2e/artifacts/sprites-spider-bat.png" });
});

test("leaderboard podium fits full names at 1080p", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/display/1?preview=board&fixture=long&art=1&theme=halloween&shot=1");
  await expect(page.getByText("First")).toBeVisible();
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const report = await page.evaluate(() => {
    const board = document.querySelector(".board-main");
    const podium = document.querySelector("#podium");
    const rows = document.querySelector("#board-rows");
    const first = document.querySelector(".place-1");
    const second = document.querySelector(".place-2");
    const text = board ? board.innerText : "";
    const problems = [];
    for (const el of board.querySelectorAll("*")) {
      if (el.closest("[hidden]")) continue;
      if (el.clientWidth < 2 || el.clientHeight < 2) continue;
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
        problems.push({
          className: String(el.className).slice(0, 40),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          text: (el.textContent || "").slice(0, 40),
        });
      }
    }
    return {
      text,
      problems: problems.slice(0, 6),
      podiumAboveRows: podium.getBoundingClientRect().top < rows.getBoundingClientRect().top,
      firstTaller: first.getBoundingClientRect().height > second.getBoundingClientRect().height,
      textAboveParticles: Number(getComputedStyle(board).zIndex) > Number(getComputedStyle(document.querySelector("#motion")).zIndex),
    };
  });
  expect(report.text.toLowerCase()).toContain("the wizard of oz (75th anniversary edition)");
  expect(report.text).toContain("Alexander Montgomery-Parra");
  expect(report.text).not.toContain("…");
  expect(report.text).not.toContain("...");
  expect(report.problems, JSON.stringify(report.problems)).toEqual([]);
  expect(report.podiumAboveRows).toBe(true);
  expect(report.firstTaller).toBe(true);
  expect(report.textAboveParticles).toBe(true);
  await page.screenshot({ path: "e2e/artifacts/leaderboard-1080.png" });
});

test("pinboard polaroids stay inside the 1080p frame", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const count of [1, 5, 15, 40]) {
    await page.goto(`/display/1?preview=pinboard&pins=${count}&shot=1`);
    await page.waitForSelector(".pin-card");
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const report = await page.evaluate(() => {
      const view = { w: window.innerWidth, h: window.innerHeight };
      const cards = [...document.querySelectorAll(".pin-card")];
      const outside = cards.filter((el) => {
        const box = el.getBoundingClientRect();
        return box.left < -1 || box.top < -1 || box.right > view.w + 1 || box.bottom > view.h + 1;
      }).map((el) => {
        const box = el.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
      });
      const tilt = Math.abs(parseFloat(cards[0]?.style.getPropertyValue("--tilt")) || 0);
      return {
        view,
        count: cards.length,
        outside,
        tilt,
        caption: cards[0]?.innerText || "",
      };
    });
    const cap = Math.min(count, 12);
    expect(report.count, `pins ${count}`).toBe(cap);
    expect(report.outside, `pins ${count} ${JSON.stringify(report.outside)}`).toEqual([]);
    expect(report.tilt).toBeGreaterThanOrEqual(4);
    expect(report.tilt).toBeLessThanOrEqual(8);
    expect(report.caption).toContain("·");
    if (count === 15) await page.screenshot({ path: "e2e/artifacts/pinboard-15-1080.png" });
  }
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
