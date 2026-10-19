const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const tasks = ["PinballLandServer", "PinballLandKiosk", "PinballLandUpdateBoot", "PinballLandUpdateNightly"];

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("installers register boot tasks only when kiosk autostart is requested", () => {
  const confirm = read("scripts/confirm-kiosk-autostart.ps1");
  const updater = read("scripts/enable-autoupdate.ps1");
  const installer = read("scripts/install-kiosk-windows.ps1");
  const beelink = read("scripts/install-beelink.ps1");
  assert.match(confirm, /\[switch\]\$Kiosk/);
  assert.match(confirm, /Start at sign-in\? \[y\/N\]/);
  assert.match(confirm, /Dev and test PCs/);
  assert.match(updater, /Confirm-KioskAutostart -Kiosk:\$Kiosk -DryRun:\$DryRun/);
  assert.match(updater, /if \(\$registerAutostart\) \{[\s\S]*register-update-tasks\.ps1/);
  assert.match(installer, /Confirm-KioskAutostart -Kiosk:\$Kiosk -DryRun:\$DryRun/);
  assert.match(installer, /if \(\$registerAutostart\) \{[\s\S]*register-update-tasks\.ps1/);
  assert.match(beelink, /\[switch\]\$Kiosk/);
  assert.match(beelink, /\$configure\.Kiosk = \$true/);
  const registerAt = updater.indexOf("register-update-tasks.ps1");
  const gateAt = updater.indexOf("if ($registerAutostart)");
  assert.ok(gateAt > 0 && registerAt > gateAt);
});

test("enable and disable autostart cover the four boot tasks and self-elevate", () => {
  const enable = read("scripts/enable-autostart.ps1");
  const disable = read("scripts/disable-autostart.ps1");
  const doc = read("KIOSK.md");
  for (const name of tasks) {
    assert.match(enable, new RegExp(name));
    assert.match(disable, new RegExp(name));
    assert.match(doc, new RegExp(name));
  }
  for (const source of [enable, disable]) {
    assert.match(source, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
    assert.match(source, /-Verb RunAs/);
    assert.match(source, /Start-Process/);
  }
  assert.match(disable, /Unregister-ScheduledTask/);
  assert.match(disable, /Disable-ScheduledTask/);
  assert.match(enable, /register-update-tasks\.ps1/);
  assert.match(doc, /enable-autostart\.ps1/);
  assert.match(doc, /disable-autostart\.ps1/);
  assert.match(doc, /two minutes/);
});
