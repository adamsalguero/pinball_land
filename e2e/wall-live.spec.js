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

test("decorations sit above every wall card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const cards = [
    ["halloween", "board", "board"],
    ["halloween", "pinboard", "pinboard"],
    ["halloween", "video", "video"],
    ["christmas", "clock", "clock"],
    ["pinnacle", "logo", "logo"],
    ["pinnacle", "amenity&amenity=arcade", "amenity"],
  ];
  for (const [theme, preview, mode] of cards) {
    await page.goto(`/display/1?preview=${preview}&theme=${theme}&shot=1`);
    await expect(page.locator(".screen")).toHaveAttribute("data-mode", mode);
    const order = await page.evaluate(() => {
      const screen = document.querySelector(".screen");
      const motion = document.querySelector("#motion");
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;z-index:9999;inset:24px;transform:translate3d(0,0,0);opacity:0.4;";
      screen.append(probe);
      const trapped = [];
      const styleOf = (el) => getComputedStyle(el);
      const traps = (style) => style.transform !== "none"
        || Number(style.opacity) < 1
        || style.isolation === "isolate"
        || style.filter !== "none"
        || style.willChange.split(",").some((part) => /transform|opacity|filter/.test(part));
      let node = motion.parentElement;
      while (node) {
        if (traps(styleOf(node))) trapped.push(node.nodeName);
        node = node.parentElement;
      }
      motion.style.pointerEvents = "auto";
      const top = document.elementsFromPoint(window.innerWidth / 2, window.innerHeight / 2)[0];
      motion.style.pointerEvents = "";
      probe.remove();
      const motionStyle = styleOf(motion);
      const screenStyle = styleOf(screen);
      return {
        topIsMotion: top === motion,
        motionZ: Number(motionStyle.zIndex),
        screenZ: Number(screenStyle.zIndex),
        pointerEvents: motionStyle.pointerEvents,
        trapped,
      };
    });
    expect(order.topIsMotion, `${theme} ${preview}`).toBe(true);
    expect(order.motionZ, `${theme} ${preview}`).toBeGreaterThan(order.screenZ);
    expect(order.pointerEvents, `${theme} ${preview}`).toBe("none");
    expect(order.trapped, `${theme} ${preview}`).toEqual([]);
  }
});

test("leaderboard podium fits full names at 1080p", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/display/1?preview=board&fixture=long&art=1&theme=halloween&shot=1");
  await expect(page.getByText("First", { exact: true })).toBeVisible();
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
      decorationsAboveBoard: Number(getComputedStyle(document.querySelector("#motion")).zIndex) > Number(getComputedStyle(document.querySelector(".screen")).zIndex),
    };
  });
  expect(report.text.toLowerCase()).toContain("the wizard of oz (75th anniversary edition)");
  expect(report.text).toContain("Alexander Montgomery-Parra");
  expect(report.text).not.toContain("…");
  expect(report.text).not.toContain("...");
  expect(report.problems, JSON.stringify(report.problems)).toEqual([]);
  expect(report.podiumAboveRows).toBe(true);
  expect(report.firstTaller).toBe(true);
  expect(report.decorationsAboveBoard).toBe(true);
  const order = await page.evaluate(() => {
    const read = (selector) => Number((document.querySelector(selector)?.textContent || "").replace(/[^0-9]/g, ""));
    const rowScores = [...document.querySelectorAll(".board-row .score")].map((el) => Number(el.textContent.replace(/[^0-9]/g, "")));
    return [read(".place-1 .points"), read(".place-2 .points"), read(".place-3 .points"), ...rowScores];
  });
  expect(order).toEqual([500000000, 6000, 5000, 200, 50]);
  const sizes = await page.evaluate(() => ({
    first: parseFloat(getComputedStyle(document.querySelector(".place-1 .who")).fontSize),
    second: parseFloat(getComputedStyle(document.querySelector(".place-2 .who")).fontSize),
    third: parseFloat(getComputedStyle(document.querySelector(".place-3 .who")).fontSize),
    artWidth: document.querySelector("#machine-art")?.naturalWidth || 0,
    artHidden: document.querySelector("#machine-art")?.hidden,
    fallbackHidden: document.querySelector("#machine-art-fallback")?.hidden,
  }));
  expect(sizes.first).toBeGreaterThan(sizes.second);
  expect(sizes.first).toBeGreaterThan(sizes.third);
  expect(sizes.second, `second ${sizes.second} first ${sizes.first}`).toBeGreaterThanOrEqual(sizes.first * 0.6);
  expect(sizes.third, `third ${sizes.third} first ${sizes.first}`).toBeGreaterThanOrEqual(sizes.first * 0.6);
  expect(sizes.third).toBeGreaterThanOrEqual(24);
  expect(sizes.second).toBeGreaterThanOrEqual(24);
  const shares = await page.evaluate(() => {
    const podium = document.querySelector("#podium").getBoundingClientRect().width;
    const share = (selector) => document.querySelector(selector).getBoundingClientRect().width / podium;
    return { first: share(".place-1"), second: share(".place-2"), third: share(".place-3") };
  });
  expect(shares.first).toBeGreaterThan(0.36);
  expect(shares.first).toBeLessThan(0.46);
  expect(shares.second).toBeGreaterThan(0.26);
  expect(shares.third).toBeGreaterThan(0.26);
  expect(sizes.artHidden).toBe(false);
  expect(sizes.artWidth).toBeGreaterThan(20);
  expect(sizes.fallbackHidden).toBe(true);
  await page.screenshot({ path: "e2e/artifacts/leaderboard-1080.png" });
});

test("broken machine art falls through to a title placeholder", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/display/1?preview=board&fixture=long&art=skip&shot=1");
  await page.waitForFunction(() => {
    const img = document.querySelector("#machine-art");
    return img && !img.hidden && img.naturalWidth > 20 && img.getAttribute("src") === "/photos/arcade";
  });
  await page.goto("/display/1?preview=board&fixture=long&art=bad&shot=1");
  await expect(page.locator("#machine-art-fallback")).toBeVisible();
  await expect(page.locator("#machine-art")).toBeHidden();
  await expect(page.locator("#machine-art-fallback")).toContainText("Wizard of Oz");
  const broken = await page.evaluate(() => {
    const img = document.querySelector("#machine-art");
    return Boolean(img && !img.hidden && img.complete && img.naturalWidth === 0);
  });
  expect(broken).toBe(false);
});

test("pinboard polaroids stay inside the 1080p frame", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const imgWidths = {};
  for (const count of [1, 5, 15, 40]) {
    await page.goto(`/display/1?preview=pinboard&pins=${count}&shot=1`);
    await page.waitForSelector(".pin-card");
    await page.waitForFunction(() => {
      const img = document.querySelector("#pin-qr");
      return img && img.complete && img.naturalWidth > 20;
    });
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
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const qr = document.querySelector(".pin-qr")?.getBoundingClientRect();
      const captions = cards.map((card) => {
        const cap = card.querySelector("span");
        const box = cap.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          text: cap.textContent || "",
          clipped: cap.scrollWidth > cap.clientWidth + 1 || cap.scrollHeight > cap.clientHeight + 1,
          covered: hit !== cap && !cap.contains(hit),
          box,
        };
      });
      const captionHits = [];
      for (let i = 0; i < cards.length; i += 1) {
        const capBox = captions[i].box;
        for (let j = 0; j < cards.length; j += 1) {
          if (i === j) continue;
          if (intersects(capBox, cards[j].getBoundingClientRect())) captionHits.push([i, j]);
        }
      }
      const qrHits = qr ? cards.filter((card) => intersects(card.getBoundingClientRect(), qr)).length : 0;
      const photos = cards.map((card) => card.querySelector("img")?.naturalWidth || 0);
      const imgWidths = cards.map((card) => card.querySelector("img")?.getBoundingClientRect().width || 0);
      const tilts = cards.map((card) => parseFloat(card.style.getPropertyValue("--tilt")) || 0);
      const tilt = Math.abs(tilts[0] || 0);
      return {
        view,
        count: cards.length,
        outside,
        tilt,
        tilts,
        caption: cards.map((card) => card.innerText || "").join("\n"),
        clipped: captions.filter((item) => item.clipped).length,
        covered: captions.filter((item) => item.covered).length,
        captionHits,
        qrHits,
        photos,
        imgWidth: imgWidths.reduce((sum, value) => sum + value, 0) / Math.max(1, imgWidths.length),
      };
    });
    const cap = Math.min(count, 12);
    expect(report.count, `pins ${count}`).toBe(cap);
    expect(report.outside, `pins ${count} ${JSON.stringify(report.outside)}`).toEqual([]);
    expect(report.tilt).toBeGreaterThanOrEqual(1);
    expect(report.tilt).toBeLessThanOrEqual(3);
    for (const tilt of report.tilts) {
      expect(Math.abs(tilt), `pins ${count} tilt`).toBeGreaterThanOrEqual(1);
      expect(Math.abs(tilt), `pins ${count} tilt`).toBeLessThanOrEqual(3);
    }
    if (cap >= 8) {
      expect(new Set(report.tilts.map((tilt) => Math.sign(tilt))).size, `pins ${count} directions`).toBe(2);
      expect(new Set(report.tilts.map((tilt) => Math.abs(tilt).toFixed(2))).size, `pins ${count} amounts`).toBeGreaterThan(2);
    }
    if (count <= 12) expect(report.caption).toContain("Adam Salguero");
    expect(report.caption).toContain("·");
    expect(report.caption).not.toContain("…");
    expect(report.clipped, `pins ${count} clipped`).toBe(0);
    expect(report.covered, `pins ${count} covered`).toBe(0);
    expect(report.captionHits, `pins ${count} caption overlap`).toEqual([]);
    expect(report.qrHits, `pins ${count} qr`).toBe(0);
    expect(Math.min(...report.photos), `pins ${count} photo`).toBeGreaterThan(20);
    imgWidths[cap] = report.imgWidth;
    if (cap === 12) expect(report.imgWidth, `pins ${count} fill`).toBeGreaterThanOrEqual(200);
    if (count === 5) await page.screenshot({ path: "e2e/artifacts/pinboard-names.png" });
    if (count === 15) await page.screenshot({ path: "e2e/artifacts/pinboard-15-1080.png" });
  }
  expect(imgWidths[1]).toBeGreaterThan(imgWidths[5]);
  expect(imgWidths[5]).toBeGreaterThan(imgWidths[12]);
});

test("clock uses the halloween slogan", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/display/1?preview=clock&theme=halloween&shot=1");
  await expect(page.locator("#clock-event")).toHaveText("Happy Halloween!");
  await expect(page.locator("#clock")).not.toContainText("Tonight");
  await page.screenshot({ path: "e2e/artifacts/clock-halloween.png" });
});

test("camera hides the raw file inputs and opens a photo lightbox", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Take Photo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose Photo" })).toBeVisible();
  await expect(page.locator("#take-file")).toBeHidden();
  await expect(page.locator("#choose-file")).toBeHidden();
  await expect(page.locator("#photo-lightbox")).toBeHidden();
  const guestJs = await page.evaluate(async () => (await fetch("/guest.js")).text());
  expect(guestJs).toContain("navigator.share");
  expect(guestJs).not.toContain("window.location");
  await page.evaluate(() => {
    const box = document.getElementById("photo-lightbox");
    box.dataset.photoUrl = "/photos/arcade";
    box.dataset.photoName = "arcade.jpg";
    document.getElementById("photo-lightbox-img").src = "/photos/arcade";
    box.hidden = false;
  });
  await expect(page.locator("#photo-lightbox")).toBeVisible();
  const close = await page.locator("#photo-lightbox-close").boundingBox();
  expect(close.x).toBeLessThan(40);
  const url = page.url();
  await page.locator("#photo-lightbox-download").click();
  await expect(page).toHaveURL(url);
  await expect(page.locator("#photo-lightbox")).toBeVisible();
  await page.locator("#photo-lightbox-close").click();
  await expect(page.locator("#photo-lightbox")).toBeHidden();
});

test("pinnacle has no cartoon button, and an empty board can be pinned", async ({ page, request }) => {
  const theme = await request.put("/api/theme", {
    headers: { "x-pin": "2224" },
    data: { theme: "pinnacle" },
  });
  expect(theme.ok()).toBeTruthy();
  await page.goto("/admin");
  await page.locator("#pin-input").fill("2224");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator("#app")).toBeVisible();
  const left = page.locator(".screen-card").first();
  await expect(left.getByRole("button", { name: "Video", exact: true })).toHaveCount(0);
  await expect(left.getByRole("button", { name: "The Skeleton Dance" })).toHaveCount(0);
  await expect(left.getByRole("button", { name: "Leaderboard" })).toBeDisabled();
  const added = await request.post("/api/machines", {
    headers: { "x-pin": "2224", "content-type": "application/json" },
    data: { name: "Attack From Mars", opdbId: "GTEST-AFM" },
  });
  expect(added.ok()).toBeTruthy();
  await page.reload();
  await expect(page.locator(".screen-card").first().getByRole("button", { name: "Leaderboard" })).toBeEnabled();
  await page.locator(".screen-card").first().getByRole("button", { name: "Leaderboard" }).click();
  await expect(page.locator("#toast")).toHaveText("Layout saved");
  await page.goto("/display/1?shot=1");
  await expect(page.locator("#board-title")).toHaveText("Attack From Mars");
  await expect(page.locator("#board-empty")).toHaveText("Be the first");
  await expect(page.locator("#board")).not.toContainText("No machine art");
  await expect(page.locator("#board")).not.toContainText("error");
  await request.put("/api/displays", {
    headers: { "x-pin": "2224", "content-type": "application/json" },
    data: { screens: { 1: { content: "rotation" }, 2: { content: "rotation" }, 3: { content: "rotation" } } },
  });
});

async function launchWallChrome() {
  const { chromium } = require("@playwright/test");
  const args = ["--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--disable-dev-shm-usage"];
  try {
    return await chromium.launch({ channel: "chrome", headless: true, args });
  } catch {
    return chromium.launch({ headless: true, executablePath: chromium.executablePath(), args });
  }
}

test("cached halloween cartoon advances past ten seconds in Chrome", async ({ request }) => {
  test.setTimeout(180000);
  await expect.poll(async () => {
    const res = await request.get("/api/media/cache");
    const body = await res.json();
    const clip = (body.clips || []).find((item) => item.id === "skeleton-dance-1929");
    if (!clip) return "missing";
    return clip.ready ? "ready" : `wait:${clip.error || "downloading"}`;
  }, { timeout: 150000 }).toBe("ready");
  const browser = await launchWallChrome();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  try {
    const theme = await request.put("/api/theme", {
      headers: { "x-pin": "2224" },
      data: { theme: "halloween" },
    });
    expect(theme.ok()).toBeTruthy();
    // The holiday clip walks across every auto screen. Leave only the left
    // screen on so this sample can watch one clip for ten seconds.
    const pinned = await request.put("/api/displays", {
      headers: { "x-pin": "2224" },
      data: {
        screens: {
          1: { content: "rotation", enabled: true },
          2: { content: "rotation", enabled: false },
          3: { content: "rotation", enabled: false },
        },
      },
    });
    expect(pinned.ok()).toBeTruthy();
    await page.goto("/display/1");
    await page.waitForFunction(() => {
      const video = document.querySelector("#wall-video");
      const screen = document.querySelector("#screen");
      const src = String(video?.currentSrc || "");
      return screen?.dataset.mode === "video"
        && video
        && !video.hidden
        && !video.paused
        && video.readyState >= 2
        && video.currentTime > 0.3
        && src.startsWith("blob:")
        && String(video.dataset.mediaUrl || "").includes("/media/cache/skeleton-dance-1929");
    }, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const sample = () => page.evaluate(() => {
      const video = document.querySelector("#wall-video");
      const canvas = document.createElement("canvas");
      canvas.width = 48;
      canvas.height = 27;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, 48, 27);
      return {
        time: video.currentTime,
        paused: video.paused,
        mode: document.querySelector("#screen")?.dataset.mode,
        card: document.querySelector("#screen")?.dataset.card || "",
        logoHidden: document.querySelector("#logo")?.hidden,
        frame: Array.from(ctx.getImageData(0, 0, 48, 27).data),
      };
    });
    const first = await sample();
    await page.waitForTimeout(11000);
    const second = await sample();
    const changed = first.frame.reduce((count, value, index) => count + (Math.abs(value - second.frame[index]) > 12 ? 1 : 0), 0);
    expect(second.time - first.time).toBeGreaterThan(10);
    expect(changed).toBeGreaterThan(30);
    expect(second.mode).toBe("video");
    expect(second.logoHidden).toBe(true);
    expect(second.card.startsWith("video:starter:skeleton-dance-1929")).toBe(true);
    await page.waitForTimeout(1500);
    const third = await sample();
    expect(third.time - second.time).toBeGreaterThan(1);
    await page.screenshot({ path: "e2e/artifacts/halloween-cartoon-10s.png" });
  } finally {
    await context.close();
    await browser.close();
    await request.put("/api/theme", { headers: { "x-pin": "2224" }, data: { theme: "pinnacle" } });
    await request.put("/api/displays", {
      headers: { "x-pin": "2224" },
      data: {
        screens: {
          1: { content: "rotation" },
          2: { content: "rotation" },
          3: { content: "rotation" },
        },
      },
    });
  }
});
