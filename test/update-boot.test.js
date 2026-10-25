const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("sign-in update waits for github.com and schedules one later retry", () => {
  const script = read("scripts/invoke-update.ps1");
  assert.match(script, /\[ValidateSet\("boot", "nightly", "now", "retry"\)\]/);
  assert.match(script, /\[System\.Net\.Dns\]::GetHostAddresses\("github\.com"\)/);
  assert.match(script, /Wait-ForGithubDns -TimeoutSec 120/);
  assert.match(script, /AddMinutes\(3\)/);
  assert.match(script, /PinballLandUpdateRetry/);
  assert.match(script, /-WindowStyle Hidden -File `"\$wrapper`" -Mode retry/);
  assert.match(script, /if \(\$incomingMode -eq "boot" -and \(Test-NetworkSkip \(Read-UpdateStatus\)\)\)/);
  assert.match(script, /Could not resolve host/);
  const retry = script.indexOf('if ($Mode -eq "retry")');
  const stopCall = script.indexOf("  Stop-PinballTasks\n");
  const schedule = script.indexOf('if ($incomingMode -eq "boot"');
  assert.ok(retry > 0 && stopCall > retry, "a retry waits for DNS before it stops the wall");
  assert.ok(schedule > stopCall, "only the sign-in path schedules the follow-up");
  assert.match(script.slice(retry, stopCall), /retry gave up; github.com still does not resolve/);
  assert.doesNotMatch(script.slice(retry, stopCall), /Register-UpdateRetry/);
  const finalAt = script.indexOf("} finally {");
  assert.ok(finalAt > schedule, "the wall starts after the update, including when the update throws");
  assert.match(script.slice(finalAt), /Start-Wall/);
});

test("server and kiosk tasks launch through a hidden script", () => {
  const register = read("scripts/register-update-tasks.ps1");
  const launcher = read("scripts/launch-hidden.vbs");
  assert.match(register, /wscript\.exe/);
  assert.match(register, /launch-hidden\.vbs/);
  assert.match(register, /\$hiddenArgs server/);
  assert.match(register, /\$hiddenArgs kiosk/);
  assert.match(register, /\$hiddenArgs boot/);
  assert.match(register, /\$hiddenArgs nightly/);
  assert.match(launcher, /\/\/B \/\/Nologo/);
  assert.match(launcher, /src\\server\.js/);
  assert.match(launcher, /start-kiosk\.ps1/);
  assert.match(launcher, /invoke-update\.ps1/);
  assert.match(launcher, /-WindowStyle Hidden/);
  assert.match(launcher, /shell\.Run command, 0, False/);
  assert.match(launcher, /shell\.Run command, 0, True/);
  const server = read("src/server.js");
  assert.match(server, /function hideServerConsole\(/);
  assert.match(server, /GetConsoleWindow/);
  assert.match(server, /ShowWindow/);
  assert.match(server, /require\.main === module/);
  assert.match(server, /hideServerConsole\(\)/);
});

test("the kiosk task opens Chrome when Electron exits early", () => {
  const cmd = read("scripts/start-kiosk.cmd");
  const starter = read("scripts/start-kiosk.ps1");
  const kiosk = read("src/kiosk.js");
  assert.match(cmd, /start-kiosk\.ps1/);
  assert.match(cmd, /exit \/b %ERRORLEVEL%/);
  assert.match(starter, /electron\\dist\\electron\.exe/);
  assert.match(starter, /src\\kiosk\.js/);
  assert.match(starter, /open-wall-chrome\.ps1/);
  assert.match(starter, /WaitForExit\(15000\)/);
  assert.match(starter, /exited early/);
  assert.match(kiosk, /setPath\("userData", kioskUserData\)/);
  assert.match(kiosk, /single-instance lock/);
  assert.match(kiosk, /app\.exit\(0\)/);
});

test("the score QR sits in the bottom-right and does not share the title row", () => {
  const html = read("public/display.html");
  const css = read("public/display.css");
  const header = html.slice(html.indexOf('<header class="board-header">'), html.indexOf("</header>"));
  assert.equal(header.includes("board-score-qr"), false);
  assert.match(html, /Submit scores here/);
  assert.match(html, /Post pictures here/);
  assert.match(css, /\.board-score-qr \{[^}]*position:\s*absolute;/);
  assert.match(css, /\.board-score-qr \{[^}]*right:\s*0;/);
  assert.match(css, /\.board-score-qr \{[^}]*bottom:\s*0;/);
  assert.doesNotMatch(css, /grid-row:\s*1\s*\/\s*span\s*4/);
  assert.match(css, /\.board-score-qr p \{[^}]*text-transform:\s*none;/);
});
