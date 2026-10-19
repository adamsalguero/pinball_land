# Kiosk wall (Windows 11 + BIOS)

Supported venue PC: **Beelink SER5** running **Windows 11** (the image it ships with). Adam’s home PC is also Windows. Do **not** install Linux for this wall. The short install is [QUICKSTART.md](QUICKSTART.md).

`npm start` is server-only (home testing). `npm run kiosk` starts the server if needed and opens a frameless fullscreen window for each **enabled** display, left to right: `/display/1`, then `/display/2`, then `/display/3`. The control page stays on the phone/iPad. How many screens are in use (1, 2, or 3) is set under **Displays** on that page and saved in `config.json`.

The wall **auto-rotates by default**: logos, three amenity cards, and every enabled leaderboard, staggered across TVs. Interval and playlist toggles are on the control page. **Off** still blacks every screen immediately.

Optional pinball art: a free OPDB API token (`config.json` `opdbApiKey` or env `OPDB_API_KEY`). Without it, add machines by name and type scores as usual.

---

## 1. BIOS: this is what turns the PC back on after a power cut

A Windows PC usually **stays off** when AC returns. That is BIOS “AC power loss” behavior, not an OS kiosk bug.

On the SER5, enter BIOS (usually **Del** or **F2** at the Beelink splash):

1. Find one of these menus (AMI BIOS labels vary by SER5 generation):
   - **Power** → **Auto Power On**
   - **Power** → **After Power Loss** / **Restore AC Power Loss**
   - **Advanced** → **ACPI Settings** → **After Power Loss**
   - **Chipset** / **PCH** → **AC Back Function**
2. Set it to **Power On** (sometimes **Always On**).
3. Do **not** leave it at **Last State** or **Power Off**.
4. Save and exit (usually **F10**).

Test: run the PC, pull the power brick, wait 10 seconds, plug it back in. The SER5 should power on by itself with no keypress.

---

## 2. TVs also stay off after an outage

The PC coming back is not enough if the panels stay in standby.

**BenQ (current wall):** OSD → **System** (or **Setup**) → **Switch on state** / **Direct Power On** / **Auto Power** = **On** (wake when AC is applied).

**Later consumer HDMI replacements:** look for **Power on with signal**, **HDMI auto power on**, **Last on**, or **CEC**. Set the TV to come on when the HDMI source appears.

---

## 3. Windows 11: stay awake, auto-logon, start the kiosk

No Assigned Access / Windows Kiosk Mode is required.

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org) using **“Install for all users”** (so PATH works after auto-logon). Reboot once.
2. Clone or copy this repo to a stable path, for example `C:\pinball-land`.
3. In that folder:

   ```bat
   npm install
   npm run kiosk
   ```

   Confirm a fullscreen display window on each enabled monitor, left to right. Control from a phone at the printed LAN URL (`http://<pc-ip>:3000/admin`, PIN `2224`). Guests use `http://<pc-ip>:3000/`. The first start also creates a local HTTPS certificate so guests can share a browser tab (see [PRESENTING.md](PRESENTING.md)).
4. Keep Windows awake (the install script does this too):

   ```bat
   powercfg /change standby-timeout-ac 0
   powercfg /change monitor-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   ```

   Settings → System → Power → Screen and sleep → **Never** on AC. Also: Settings → System → Display → Screen timeout **Never**.
5. Auto-logon to a local account (kiosk user is fine): `Win+R` → `netplwiz` → uncheck **Users must enter a user name and password to use this computer** → apply → enter that account’s password.
6. Pause automatic **update restarts** (events are evenings): Settings → Windows Update → Advanced → **Pause updates**, or Active hours covering venue nights. Surprise reboot mid-party is worse than a pending update.
7. Register logon auto-start (re-runnable):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-kiosk-windows.ps1
   ```

   This creates Task Scheduler jobs for the server, the wall, and the automatic update. Uninstall:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\uninstall-kiosk-windows.ps1
   ```

8. Firewall: when Windows asks, **allow Node.js** on private networks, ports **3000** (control and TVs) and **3443** (browser share). Or:

   ```powershell
   netsh advfirewall firewall add rule name="Pinball Land kiosk" dir=in action=allow protocol=TCP localport=3000
   netsh advfirewall firewall add rule name="Pinball Land browser share" dir=in action=allow protocol=TCP localport=3443
   ```

   AirPlay also needs UxPlay allowed on private networks the first time it runs. Install it with `scripts\install-airplay-windows.ps1` (Administrator PowerShell). Details are in [PRESENTING.md](PRESENTING.md).

9. On a PC that was installed before automatic updates, run this once, then restart:

   ```powershell
   cd C:\pinball-land
   git pull
   npm.cmd ci
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-autoupdate.ps1 -RustDeskPassword "your-permanent-password"
   shutdown /r /t 0
   ```

   That registers **PinballLandUpdateBoot** (at sign-in, before the server) and **PinballLandUpdateNightly** (default 3:17 AM local, `config.json` `updates.nightlyAt`). The log is `C:\ProgramData\PinballLand\logs\update.log`. Venue data in `C:\ProgramData\PinballLand` is not deleted. Admin, Settings shows the commit, the last result, and **Update now**.

10. Tests:
   - Sign out and back in: kiosk windows should appear without clicking anything.
   - Reboot: same.
   - Pull the power brick: BIOS should power on, Windows auto-logon, kiosk windows on all TVs. If the PC comes on but TVs stay dark, fix step 2.

Cursor is hidden on display windows. Control is not opened on the wall.

---

## 4. Home PC (Windows, no auto-boot)

Home testing does **not** need BIOS auto-power, Task Scheduler, or `npm run kiosk`.

```bat
npm install
npm start
```

Open the three displays with `scripts\open-wall-chrome.ps1` after `npm start`. Control from `/admin` or a phone on the same WiFi. Optional: `npm run kiosk` if you want to try auto-fullscreen on the monitors you have. With fewer monitors than **Displays** says are active, the kiosk skips the missing ones and prints that in the terminal.

Chrome allows six HTTP/1.1 connections per host, and every window in one profile shares that pool. The wall therefore opens each screen on its own origin: `http://localhost:3000/display/1`, `http://127.0.0.1:3000/display/2`, and `http://[::1]:3000/display/3`. Admin stays on `http://localhost:3000/admin` (or the LAN address printed at startup). WebSockets follow the page host, so each display talks to the server it loaded from. If IPv6 loopback does not come up, the server listens on `http://127.0.0.1:3001` for screen 3 and the script uses that instead.

Overlapping Chrome windows on Windows pause muted video in the covered window. Launch each display with the occlusion flags (or run `scripts\open-wall-chrome.ps1`, which picks the three origins above):

```bat
chrome.exe --app=http://localhost:3000/display/1 --window-position=0,0 --window-size=1280,720 --autoplay-policy=no-user-gesture-required --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-background-media-suspend --disable-features=CalculateNativeWinOcclusion,BackgroundMediaSuspend,IntensiveWakeUpThrottling,OnBeginFrameThrottleVideo
chrome.exe --app=http://127.0.0.1:3000/display/2 --window-position=80,60 --window-size=1280,720 --autoplay-policy=no-user-gesture-required --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-background-media-suspend --disable-features=CalculateNativeWinOcclusion,BackgroundMediaSuspend,IntensiveWakeUpThrottling,OnBeginFrameThrottleVideo
chrome.exe --app=http://[::1]:3000/display/3 --window-position=160,120 --window-size=1280,720 --autoplay-policy=no-user-gesture-required --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --disable-background-media-suspend --disable-features=CalculateNativeWinOcclusion,BackgroundMediaSuspend,IntensiveWakeUpThrottling,OnBeginFrameThrottleVideo
```

The Electron kiosk sets the same switches, `backgroundThrottling: false`, and the same three origins. Displays stay on HTTP/1.1. Browser HTTP/2 needs TLS, and the bounded media ranges plus separate origins are what keep the connection pool free.

After three stall timeouts or give-ups, the server turns on software video decode. The next launch of `scripts\open-wall-chrome.ps1` or the Electron kiosk adds `--disable-gpu-video-decode` and `--disable-accelerated-video-decode`.

---

## 5. Displays (1, 2, or 3)

On the control page, **Displays**:

- **1 / 2 / 3 screens** — how many TVs this wall is using. Adam can test with 3 now and drop to 1 or 2 later without a code change.
- **Enabled / Disabled** on each screen. A disabled screen does not get a kiosk window.
- **What that screen shows** — Rotation, a logo, an amenity card, a leaderboard, or black. A screen set to something other than Rotation stays there while the others keep rotating.
- **Mirror one layout to all** — every enabled screen uses screen 1’s layout, including the same rotation card at the same time.
- **Monitor order** — after `npm run kiosk` is running, the iPad lists the monitors Windows reported. Up/Down overrides left-to-right. **Reset to left-to-right** clears that override.
- **Restart kiosk windows** — closes and reopens the TV windows. Count, enable, and order also apply on their own within a few seconds. Content changes show up immediately and do not reopen the windows.

Saved in `config.json` under `displays` (and `presentation.idleMinutes`). If Windows has fewer monitors than the count, those slots are skipped and the terminal says so. Extra monitors past the count are ignored.

---

## 6. TV power (Kasa plugs)

The control page **Smart plugs** section talks to Kasa outlets on the local network. Older plugs use the legacy protocol on UDP/TCP port 9999. Newer firmware (HS103 hardware 5.0, software 1.1.x, and similar) closes port 9999 and speaks TP-Link KLAP over `http://<plug>/app` on port 80. The server tries KLAP first for a new plug, then the legacy port.

1. Plug each **TV** into its own Kasa plug. **Never put the wall PC on a smart plug.** If that plug turns off, the kiosk dies and nothing can turn it back on from the iPad.
2. On each BenQ, OSD → **System** (or **Setup**) → **Switch on state** = **On**. The panel then powers on when the plug restores AC. Without that, the plug can be “on” while the TV stays in standby.
3. On the iPad, tap **Find plugs**, then assign one plug to display 1, 2, and 3. Each plug can only belong to one screen. Discovery broadcasts on every real IPv4 subnet (for example `192.168.1.255`) and on `255.255.255.255`. It skips `169.254.*` adapters such as an extra Wi-Fi or Bluetooth interface.
4. If Find plugs lists nothing, use **Add plug** with the plug’s IP address (for example `192.168.1.159`).
5. A plug that was set up in the Kasa app needs that same TP-Link email and password. Enter them under **Save TP-Link login**. The password stays on the PC. The browser only sees a masked email and whether a password is saved. A plug that was never added to a TP-Link account can answer with the factory blank login, and the default `kasa@tp-link.net` / `kasaSetup` pair is tried as well. Settings asks for that login only after the plug completes the handshake and none of those logins match. A plug that does not answer is not a login problem. The wall does not show the error.
6. **On** / **Off** under a screen switches that plug and shows On, Off, or — if the plug has not answered yet. The same line shows a short success or failure. **TVs On** / **TVs Off** hit every assigned plug. HS103 firmware 1.1.x speaks KLAP through a short HTTP/1.1 POST (Host, Content-Length, and Cookie only). Actions and errors are appended to `logs\plugs.log` without the password or the session cookie.
7. Optional schedule, for example on at `10:00` and off at `22:00`. The PC clock is the clock that matters. An overnight window (on `22:00`, off `02:00`) is allowed. The schedule applies the current open/closed state, then again when the window changes.

Windows Firewall on a **Public** network (the usual home classification) drops the UDP replies unless node.exe is allowed inbound. The installer and `scripts\enable-autoupdate.ps1` add a rule named **Pinball Land plug discovery** for inbound UDP on Private and Public profiles. Re-run either script on a PC that was installed before this rule existed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\enable-autoupdate.ps1
```

Home testing has no plugs. The buttons talk to whatever is on the LAN; the automated tests use a fake client and do not scan the network.

## 7. Videos and party themes

Clips live in the `media\` folder (`library`, `halloween`, `christmas`). Upload from the iPad. Nothing in this repo is a movie or cartoon download. Legal places to get clips are in **[MEDIA.md](MEDIA.md)**.

- **All-ages** is on by default. A clip marked not all-ages stays out of rotation and cannot be played until you turn All-ages off.
- Halloween and Christmas themes add the matching folder (and matching tags) to the wall rotation. Pinnacle brand does not, unless you tap **Add to rotation** on that clip.
- **Play here** uses the screen selected under Present. **Sync all** plays the same clip on every enabled TV, lined up on one clock. **Span all** stretches one picture across the wall, a slice per TV.
- The kiosk asks Chromium for hardware H.264/HEVC decode. H.264 works on the SER5. HEVC may need the Microsoft **HEVC Video Extensions** from the Microsoft Store. Do not turn GPU acceleration off.

## 8. Presenting on one screen

Guests can take one TV for a presentation. The other TVs keep rotating. End it from the iPad, or it ends itself after the idle minutes (default 10). **Off** still blacks every screen.

Browser share, AirPlay, a web address, and an uploaded PDF or image are covered step by step in **[PRESENTING.md](PRESENTING.md)**. Google Cast does not run on this PC. Chrome users use browser share. A Chromecast or Google TV dongle on a spare HDMI input is the hardware option, also in that doc.

Control stays PIN-protected. The guest page (`/present`) is only for devices on this WiFi, and it asks for the 4-digit code shown on the TV.

---

## Guests from outside the venue WiFi

Tailscale Funnel gives the wall a free, fixed `https://<machine>.<tailnet>.ts.net` address. Guests open it in a phone browser. They do not install an app. The wall QR adds a code that changes every day at 4:00 AM. A phone that scanned it stays signed in for 12 hours. Phones on the venue WiFi skip the code. Anyone on the internet without the code sees “Scan the QR code at Pinball Land”.

One-time setup, from an Administrator Command Prompt, in the install folder (usually `C:\pinball-land`):

```bat
cd /d C:\pinball-land
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enable-public-access.ps1
```

The script installs Tailscale if it is missing (winget, then the stable MSI), starts the Tailscale service, and prints a login URL the first time this PC joins the tailnet. Open that URL, sign in with the free Tailscale account, then let the script finish. It runs `tailscale funnel --bg 3010` so `https://<machine>.<tailnet>.ts.net` points at the guest-only port. The Tailscale service keeps that up across reboot. Re-run the same command any time; it does not redo a login that already worked. If the guest port is not 3010, pass `-Port` with that port. Do not pass 3000.

Then on the admin iPad, Settings, turn **Public access** on. The status line shows the public URL when Funnel is up. Until then, the QR stays on the venue WiFi address.

If Tailscale is not installed, check **Cloudflare quick tunnel if Tailscale is not up**. Turning **Public access** on also opens the guest port `3010` at startup. The server downloads `cloudflared.exe` into `C:\ProgramData\PinballLand\bin`, checks its checksum, and starts that file by its full path (it does not look for `cloudflared` on PATH). The program is pointed at `http://127.0.0.1:3010`. The status line shows the `trycloudflare.com` link, or a plain reason if the port did not open, the download failed, or the program did not start. The same lines are in `logs\tunnel.log`. That address changes when the PC restarts. It is a fallback, not the guest link to print.

Funnel and the Cloudflare fallback point at the guest-only port **3010**, not at 3000. That port serves the guest app, its pictures, score submit, and photo submit. Admin, the wall displays, plugs, and `/api/state` are not on it. A request that arrives through Cloudflare or Tailscale Funnel (those proxies connect from 127.0.0.1 and add `Cf-Ray`, `Cf-Connecting-Ip`, `Cdn-Loop`, `Tailscale-Funnel-Request`, or `X-Forwarded-For`) is refused with 404 for anything except the guest app, even if it hits port 3000. Guests still need the daily code from the wall QR. After five wrong PINs from one address on the venue WiFi, that address waits 15 minutes. A successful sign-in remembers the phone for 30 days. **Pause uploads** stops new photos. **Pinboard photos** off removes the pinboard from rotation, hides the QR card, and hides photo upload on the guest page. Scores still wait for approval.

## Boot checklist

- BIOS **Restore on AC Power** (or Auto Power On) = On. See section 1.
- Windows auto-logon is set with `netplwiz`.
- `powershell -File scripts\install-kiosk-windows.ps1` registers the Node server at logon and the Electron kiosk 20 seconds later, restarts them after a crash, turns off sleep and the screensaver, and sets Windows Update active hours (9:00–23:00) so the PC does not reboot during open hours. The one-command path is [QUICKSTART.md](QUICKSTART.md).
- Check the tasks with `powershell -File scripts\install-kiosk-windows.ps1 -Verify`.
- The kiosk keeps replacing windows until every enabled display has a monitor. TVs on Kasa plugs can finish booting after the PC.
- Reset a forgotten admin PIN from the kiosk tray (**Reset PIN to default**) or with `npm run reset-pin`. Default is `2224`.

## Appendix: Ubuntu 24.04 (optional, not supported)

If someone later puts Ubuntu on a box, `scripts/kiosk.service` and `scripts/ubuntu-kiosk-setup.sh` print a systemd user-unit sketch. Do **not** treat that as the venue path. Do **not** install Linux on the SER5 for this project.
