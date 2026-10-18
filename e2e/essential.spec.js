const { test, expect } = require("@playwright/test");
const sharp = require("sharp");

async function unlock(page) {
  await page.goto("/admin");
  await page.locator("#pin-input").fill("2224");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator("#app")).toBeVisible();
}

test("PIN unlock, displays, rotation, leaderboard, theme, present", async ({ page, request }) => {
  test.setTimeout(180000);
  await unlock(page);
  await expect(page.getByRole("heading", { name: "Displays" })).toBeVisible();
  await page.getByRole("button", { name: "Auto (rotate all)" }).click();
  await page.getByRole("button", { name: "Halloween party" }).click();
  await expect.poll(async () => {
    const body = await (await request.get("/api/state")).json();
    const cached = (body.playlist || []).some((card) => card.type === "video" && String(card.url || "").includes("/media/cache/"));
    return body.state.theme === "halloween" && cached;
  }, { timeout: 150000 }).toBeTruthy();
  await page.goto("/display/1?shot=1");
  await expect(page.locator("#screen")).toBeVisible();
  await page.goto("/admin");
  await page.getByRole("button", { name: "Boards", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Score submissions" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "AirPlay" })).toBeVisible();
});

test("guest upload has no PIN and admin approves it", async ({ page, request }) => {
  const jpeg = await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#2d4c32" },
  }).jpeg().toBuffer();
  const open = await request.put("/api/guest-photos/settings", {
    headers: { "x-pin": "2224" },
    data: { autoApprove: true },
  });
  expect(open.ok()).toBeTruthy();
  const posted = await request.post("/api/guest-photos", {
    headers: { "content-type": "image/jpeg", "x-guest-name": "Sam", "x-caption": "Wall" },
    data: jpeg,
  });
  expect(posted.ok()).toBeTruthy();
  expect((await posted.json()).photo.status).toBe("approved");
  const held = await request.put("/api/guest-photos/settings", {
    headers: { "x-pin": "2224" },
    data: { autoApprove: false },
  });
  expect(held.ok()).toBeTruthy();
  const uploaded = await request.post("/api/guest-photos", {
    headers: { "content-type": "image/jpeg", "x-guest-name": "Sam", "x-caption": "Held" },
    data: jpeg,
  });
  expect(uploaded.ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pinball Land" })).toBeVisible();
  await unlock(page);
  await page.getByRole("button", { name: "Photos", exact: true }).click();
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve.first()).toBeVisible();
  await approve.first().click();
  await expect(page.getByText("approved:", { exact: false }).first()).toBeVisible();
});

test("mock plug toggle and video section", async ({ page }) => {
  await unlock(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Find plugs" }).click();
  const plug = page.getByLabel("Plug for display 1");
  await expect(plug.locator("option")).toHaveCount(2);
  await plug.selectOption("mock-1");
  await expect(page.getByRole("button", { name: "On" }).first()).toBeEnabled();
  await page.getByRole("button", { name: "TVs On" }).click();
  await expect(page.getByText("· On")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Videos", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "YouTube" })).toBeVisible();
});

test("wall and controller snapshots", async ({ page }) => {
  await page.goto("/display/1?preview=logo&shot=1");
  await expect(page.locator("#logo-image")).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/wall-logo.png" });
  await expect(page).toHaveScreenshot("wall-logo.png");

  await page.goto("/display/1?preview=board&fixture=long&shot=1");
  await expect(page.getByText("First")).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/wall-board.png" });
  await expect(page).toHaveScreenshot("wall-board.png");

  await page.goto("/display/1?preview=clock&shot=1");
  await expect(page.locator("#clock-time")).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/wall-clock.png" });

  await page.goto("/display/2?preview=amenity&shot=1");
  await expect(page.getByRole("heading", { name: "2-story arcade" })).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/wall-amenity.png" });

  await page.goto("/display/1?preview=pinboard&shot=1");
  await expect(page.locator("#pin-qr")).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/wall-pinboard.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin");
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/admin-login-mobile.png" });
  await expect(page).toHaveScreenshot("admin-login-mobile.png", { maxDiffPixelRatio: 0.08 });
  await unlock(page);
  await page.screenshot({ path: "e2e/artifacts/admin-screens-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: "e2e/artifacts/admin-screens-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.screenshot({ path: "e2e/artifacts/guest-mobile.png" });
});

test("every wall card stays inside 1080p and 720p, including long text", async ({ page }) => {
  const modes = [
    ["logo", "Logos"],
    ["amenity&amenity=arcade", "2-story arcade"],
    ["amenity&amenity=oasis", "Outdoor Oasis"],
    ["amenity&amenity=events", "Flexible Event Options"],
    ["board", "First"],
    ["pinboard", "Post a photo"],
    ["clock", "Pinnacle Entertainment Center"],
    ["video", "Video"],
  ];
  const themes = ["pinnacle", "halloween", "christmas"];
  const sizes = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ];
  for (const size of sizes) {
    await page.setViewportSize(size);
    for (const theme of themes) {
      for (const [mode] of modes) {
        await page.goto(`/display/1?preview=${mode}&theme=${theme}&fixture=long&shot=1`);
        await page.waitForFunction(() => {
          const modeName = document.querySelector("#screen")?.dataset.mode;
          return modeName && modeName !== "off";
        });
        await page.evaluate(async () => {
          if (document.fonts?.ready) await document.fonts.ready;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const overflows = await page.evaluate(() => {
          const problems = [];
          const view = document.documentElement.getBoundingClientRect();
          const nodes = document.body.querySelectorAll("*");
          for (const el of nodes) {
            if (el.closest("[hidden]")) continue;
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") continue;
            if (el.tagName === "CANVAS" || el.tagName === "SCRIPT" || el.tagName === "VIDEO") continue;
            const box = el.getBoundingClientRect();
            if (box.width < 1 && box.height < 1) continue;
            const boxBad = box.left < -1 || box.top < -1 || box.right > view.width + 1 || box.bottom > view.height + 1;
            const scrollBad = el.clientWidth > 0 && el.clientHeight > 0
              && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
            if (boxBad || scrollBad) {
              problems.push({
                tag: el.tagName,
                id: el.id,
                className: String(el.className).slice(0, 80),
                boxBad,
                scrollBad,
                scrollWidth: el.scrollWidth,
                clientWidth: el.clientWidth,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                left: Math.round(box.left),
                top: Math.round(box.top),
                right: Math.round(box.right),
                bottom: Math.round(box.bottom),
              });
            }
          }
          return problems.slice(0, 8);
        });
        expect(overflows, `${mode} ${theme} ${size.width}x${size.height}`).toEqual([]);
      }
    }
  }

  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const id of ["arcade", "oasis", "events"]) {
    await page.goto(`/display/1?preview=amenity&amenity=${id}&shot=1`);
    await expect(page.locator("#amenity-headline")).toBeVisible();
    await page.screenshot({ path: `e2e/artifacts/amenity-${id}-1080.png`, fullPage: false });
  }
});
