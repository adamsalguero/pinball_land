const { test, expect } = require("@playwright/test");
const sharp = require("sharp");

async function unlock(page) {
  await page.goto("/admin");
  await page.locator("#pin-input").fill("2224");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator("#app")).toBeVisible();
}

test("PIN unlock, displays, rotation, leaderboard, theme, present", async ({ page, request }) => {
  await unlock(page);
  await expect(page.getByRole("heading", { name: "Displays" })).toBeVisible();
  await page.getByRole("button", { name: "2 screens" }).click();
  await page.getByRole("button", { name: "Halloween party" }).click();
  const state = await request.get("/api/state");
  const body = await state.json();
  expect(body.state.theme).toBe("halloween");
  expect(body.playlist.some((card) => card.type === "video")).toBeTruthy();
  await page.goto("/display/1?shot=1");
  await expect(page.locator("#screen")).toBeVisible();
  await page.goto("/admin");
  await page.getByRole("button", { name: "Boards" }).click();
  const name = page.getByLabel("Event name");
  await name.fill("Friday finals");
  await name.press("Tab");
  await page.getByRole("button", { name: "Present" }).click();
  await expect(page.getByText("isn't practical")).toBeVisible();
});

test("guest upload has no PIN and admin approves it", async ({ page, request }) => {
  const jpeg = await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#2d4c32" },
  }).jpeg().toBuffer();
  const uploaded = await request.post("/api/guest-photos", {
    headers: { "content-type": "image/jpeg", "x-guest-name": "Sam", "x-caption": "Wall" },
    data: jpeg,
  });
  expect(uploaded.ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Pinball Land" })).toBeVisible();
  await unlock(page);
  await page.getByRole("button", { name: "Photos" }).click();
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve.first()).toBeVisible();
  await approve.first().click();
  await expect(page.getByText("approved:", { exact: false })).toBeVisible();
});

test("mock plug toggle and video section", async ({ page }) => {
  await unlock(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Find plugs" }).click();
  const plug = page.getByLabel("Plug for display 1");
  await expect(plug.locator("option")).toHaveCount(2);
  await plug.selectOption("mock-1");
  await expect(page.getByRole("button", { name: "On" }).first()).toBeEnabled();
  await page.getByRole("button", { name: "All on" }).click();
  await expect(page.getByText("· On")).toBeVisible();
  await page.getByRole("button", { name: "Media" }).click();
  await expect(page.getByRole("heading", { name: "Videos" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "YouTube" })).toBeVisible();
});

test("wall and controller snapshots", async ({ page }) => {
  await page.goto("/display/1?preview=logo&shot=1");
  await expect(page.locator("#logo-image")).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/wall-logo.png" });
  await expect(page).toHaveScreenshot("wall-logo.png");

  await page.goto("/display/1?preview=board&shot=1");
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
