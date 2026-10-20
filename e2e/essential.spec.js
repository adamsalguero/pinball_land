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
  await expect(page.getByRole("button", { name: "Halloween party" })).toHaveClass(/active/);
  const left = page.locator(".screen-card").first();
  for (const name of ["Logos", "Amenities", "Leaderboard", "Pinboard", "Clock", "Auto"]) {
    const button = left.getByRole("button", { name, exact: true });
    if (name === "Leaderboard") {
      await expect(button).toBeDisabled();
      continue;
    }
    await button.click();
    await expect(button).toHaveClass(/active/);
  }
  await page.getByRole("button", { name: "Auto (rotate all)" }).click();
  await expect(left.getByRole("button", { name: "Auto", exact: true })).toHaveClass(/active/);
  await expect.poll(async () => {
    const body = await (await request.get("/api/state")).json();
    const cached = (body.playlist || []).some((card) => card.type === "video" && String(card.url || "").includes("/media/cache/"));
    return body.state.theme === "halloween" && cached;
  }, { timeout: 150000 }).toBeTruthy();
  await page.goto("/admin");
  await expect(left.getByRole("button", { name: "Video", exact: true })).toHaveCount(0);
  await expect(left.getByRole("button", { name: "The Skeleton Dance" })).toBeVisible();
  await left.getByRole("button", { name: "The Skeleton Dance" }).click();
  await expect(page.locator("#toast")).toHaveText("Layout saved");
  await page.goto("/display/1?shot=1");
  await expect(page.locator("#screen")).toBeVisible();
  await page.goto("/admin");
  await page.getByRole("button", { name: "Boards", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Score submissions" })).toBeVisible();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "AirPlay" })).toBeVisible();
});

async function phoneJpeg() {
  const width = 1200;
  const height = 1600;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 3) {
    const n = i / 3;
    raw[i] = n & 255;
    raw[i + 1] = (n >> 3) & 255;
    raw[i + 2] = (n * 5) & 255;
  }
  let body = null;
  for (const quality of [42, 55, 70, 85]) {
    body = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality }).toBuffer();
    if (body.length >= 200 * 1024 && body.length <= 800 * 1024) return body;
  }
  return body;
}

test("a phone photo leaves admin, guest, and the displays rendering", async ({ browser }) => {
  const jpeg = await phoneJpeg();
  expect(jpeg.length).toBeGreaterThan(200 * 1024);
  const admin = await browser.newPage();
  const guest = await browser.newPage();
  const displays = [];
  for (let slot = 1; slot <= 3; slot += 1) displays.push(await browser.newPage());
  const errors = [];
  for (const page of [admin, guest, ...displays]) {
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("response", (res) => {
      if (res.status() < 400) return;
      const url = res.url();
      if (url.endsWith("/favicon.ico")) return;
      errors.push(`${res.status()} ${url}`);
    });
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (/favicon|vibrate|Failed to load resource/i.test(text)) return;
      errors.push(text);
    });
  }
  await Promise.all(displays.map((page, index) => page.goto(`/display/${index + 1}`)));
  await unlock(admin);
  await admin.getByRole("button", { name: "Photos", exact: true }).click();
  await guest.goto("/");
  await expect(guest.getByRole("heading", { name: "Pinball Land" })).toBeVisible();
  await guest.locator("#choose-file").setInputFiles({
    name: "phone.jpg",
    mimeType: "image/jpeg",
    buffer: jpeg,
  });
  await guest.locator("#post").click();
  await expect(guest.locator("#post-status")).toHaveText("Posted. It is on the pinboard.");
  await guest.getByRole("button", { name: "Pinboard" }).click();
  await expect(guest.locator("#feed img").first()).toBeVisible();
  await admin.getByRole("button", { name: "Screens" }).click();
  await expect(admin.getByRole("heading", { name: "Displays" })).toBeVisible();
  await admin.reload();
  await expect(admin.locator("#app")).toBeVisible();
  await guest.reload();
  await expect(guest.getByRole("heading", { name: "Pinball Land" })).toBeVisible();
  await guest.getByRole("button", { name: "Pinboard" }).click();
  await expect(guest.locator("#feed img").first()).toBeVisible();
  await displays[0].goto("/display/1?preview=pinboard");
  await expect(displays[0].locator("#pin-wall .pin-card img").first()).toBeVisible();
  expect(errors).toEqual([]);
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

test("mock plug toggle and video section", async ({ page, request }) => {
  await unlock(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("button", { name: "Save TP-Link login" })).toBeVisible();
  await expect(page.getByLabel("TP-Link password")).toHaveValue("");
  await page.getByLabel("TP-Link email").fill("adam@example.com");
  await page.getByLabel("TP-Link password").fill("venue-secret");
  await page.getByRole("button", { name: "Save TP-Link login" }).click();
  await expect(page.locator("#toast")).toHaveText("TP-Link login saved");
  await expect(page.getByLabel("TP-Link password")).toHaveValue("");
  await expect(page.getByLabel("TP-Link email")).toHaveAttribute("placeholder", /a•••@example.com/);
  const state = await (await request.get("/api/state")).json();
  expect(JSON.stringify(state.plugs || {})).not.toContain("venue-secret");
  expect(state.plugs.account.configured).toBe(true);
  expect(state.plugs.account.username).toBe("a•••@example.com");
  await page.getByLabel("Plug IP address").fill("not-an-ip");
  await page.getByRole("button", { name: "Add plug" }).click();
  await expect(page.locator("#toast")).toHaveText(/IPv4 address/);
  await page.getByLabel("Plug IP address").blur();
  await page.getByRole("button", { name: "Find plugs" }).click();
  const plug = page.getByLabel("Plug for display 1");
  await expect(plug.locator("option")).toHaveCount(2);
  await plug.selectOption("mock-1");
  await expect(page.locator("#toast")).toHaveText("Plug assignment saved");
  await expect(page.getByRole("button", { name: "On", exact: true }).first()).toBeEnabled();
  await page.getByRole("button", { name: "TVs On", exact: true }).click();
  await expect(page.locator("#toast")).toHaveText("Plugs on", { timeout: 15000 });
  await expect(page.getByText("Left · On")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Videos", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "YouTube" })).toBeVisible();
  await page.getByRole("button", { name: "Clear TP-Link login" }).click();
});

test("wall and controller snapshots", async ({ page }) => {
  await page.goto("/display/1?preview=logo&shot=1");
  await expect(page.locator("#logo-image")).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/wall-logo.png" });
  await expect(page).toHaveScreenshot("wall-logo.png");

  await page.goto("/display/1?preview=board&fixture=long&shot=1");
  await expect(page.getByText("First", { exact: true })).toBeVisible();
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

test("adding a score leaves existing scores collapsed", async ({ page, request }) => {
  const created = [];
  try {
    for (const [name, opdbId] of [["Adder Machine", "GTEST-ADD"], ["Other Machine", "GTEST-OTH"]]) {
      const res = await request.post("/api/machines", {
        headers: { "x-pin": "2224" },
        data: { name, opdbId },
      });
      expect(res.ok()).toBeTruthy();
      const body = await res.json();
      const board = body.state.leaderboards.find((item) => item.opdbId === opdbId);
      expect(board).toBeTruthy();
      created.push(board.id);
    }
    await unlock(page);
    await page.getByRole("button", { name: "Boards", exact: true }).click();
    const editor = page.locator("#board-editor");
    const addForm = editor.locator("form.add-score");
    await expect(addForm.getByRole("button", { name: "Add score" })).toBeVisible();
    await expect(editor.locator(".score-edit")).toHaveCount(0);
    const order = await editor.evaluate((root) => ({
      add: root.innerText.indexOf("Add score"),
      name: root.innerText.indexOf("Machine name"),
    }));
    expect(order.add).toBeGreaterThanOrEqual(0);
    expect(order.add).toBeLessThan(order.name);

    await addForm.getByLabel("New player").fill("Ada");
    await addForm.getByLabel("New score").fill("1000");
    await addForm.getByRole("button", { name: "Add score" }).click();
    await expect(page.locator("#toast")).toHaveText("Score added");
    const edit = editor.locator("summary", { hasText: "Edit existing scores" });
    await expect(edit).toBeVisible();
    await expect(editor.locator(".score-edit")).toHaveJSProperty("open", false);
    await expect(editor.locator(".player-fields")).toBeHidden();

    await edit.click();
    await expect(editor.locator(".score-edit")).toHaveJSProperty("open", true);
    await page.locator("#board-select").selectOption({ label: "Other Machine (machine)" });
    await expect(editor.locator(".score-edit")).toHaveCount(0);
    await page.locator("#board-select").selectOption({ label: "Adder Machine (machine)" });
    await expect(editor.locator(".score-edit")).toHaveJSProperty("open", false);
    await expect(editor.locator(".player-fields")).toBeHidden();

    await editor.locator("summary", { hasText: "Edit existing scores" }).click();
    const player = editor.locator(".player-fields input").first();
    await expect(player).toBeVisible();
    await expect(player).toHaveValue("Ada");
    await player.fill("Bea");
    await player.blur();
    await expect(editor.locator(".player-fields input").first()).toHaveValue("Bea");
    await expect(editor.locator(".score-edit")).toHaveJSProperty("open", true);
    await editor.locator(".score-edit").getByRole("button", { name: "Delete" }).click();
    await expect(editor.locator(".score-edit")).toHaveCount(0);
    await expect(addForm.getByRole("button", { name: "Add score" })).toBeVisible();
  } finally {
    for (const id of created) {
      await request.delete(`/api/leaderboards/${id}`, { headers: { "x-pin": "2224" } });
    }
  }
});
