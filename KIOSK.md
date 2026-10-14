# Kiosk wall (Windows 11 + BIOS)

Supported venue PC: **Beelink SER5** running **Windows 11** (the image it ships with). Adam’s home PC is also Windows. Do **not** install Linux for this wall.

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

   This creates Task Scheduler job **PinballLandKiosk** at logon and runs `scripts\start-kiosk.cmd`. Uninstall:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\uninstall-kiosk-windows.ps1
   ```

8. Firewall: when Windows asks, **allow Node.js** on private networks, ports **3000** (control and TVs) and **3443** (browser share). Or:

   ```powershell
   netsh advfirewall firewall add rule name="Pinball Land kiosk" dir=in action=allow protocol=TCP localport=3000
   netsh advfirewall firewall add rule name="Pinball Land browser share" dir=in action=allow protocol=TCP localport=3443
   ```

   AirPlay also needs UxPlay allowed on private networks the first time it runs. Install it with `scripts\install-airplay-windows.ps1` (Administrator PowerShell). Details are in [PRESENTING.md](PRESENTING.md).

9. Tests:
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

Open `http://localhost:3000/display/1` (and `/display/2` on a second monitor if you have one). Control from `/` or a phone on the same WiFi. Optional: `npm run kiosk` if you want to try auto-fullscreen on the monitors you have. With fewer monitors than **Displays** says are active, the kiosk skips the missing ones and prints that in the terminal.

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

The control page **Smart plugs** section uses `tplink-smarthome-api` on the local network. It does not use a TP-Link cloud account.

1. Plug each **TV** into its own Kasa plug. **Never put the wall PC on a smart plug.** If that plug turns off, the kiosk dies and nothing can turn it back on from the iPad.
2. On each BenQ, OSD → **System** (or **Setup**) → **Switch on state** = **On**. The panel then powers on when the plug restores AC. Without that, the plug can be “on” while the TV stays in standby.
3. On the iPad, tap **Find plugs**, then assign one plug to display 1, 2, and 3. Each plug can only belong to one screen.
4. **On** / **Off** under a screen switches that plug and shows On, Off, or — if the plug has not answered yet. **All on** / **All off** hit every assigned plug.
5. Optional schedule, for example on at `10:00` and off at `22:00`. The PC clock is the clock that matters. An overnight window (on `22:00`, off `02:00`) is allowed. The schedule applies the current open/closed state, then again when the window changes.

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

## Boot checklist

- BIOS **Restore on AC Power** (or Auto Power On) = On. See section 1.
- Windows auto-logon is set with `netplwiz`.
- `powershell -File scripts\install-kiosk-windows.ps1` registers the Node server at startup and the Electron kiosk at logon, restarts them after a crash, turns off sleep and the screensaver, and sets Windows Update active hours (9:00–23:00) so the PC does not reboot during open hours.
- Check the tasks with `powershell -File scripts\install-kiosk-windows.ps1 -Verify`.
- The kiosk keeps replacing windows until every enabled display has a monitor. TVs on Kasa plugs can finish booting after the PC.
- Reset a forgotten admin PIN from the kiosk tray (**Reset PIN to default**) or with `npm run reset-pin`. Default is `2224`.

## Appendix: Ubuntu 24.04 (optional, not supported)

If someone later puts Ubuntu on a box, `scripts/kiosk.service` and `scripts/ubuntu-kiosk-setup.sh` print a systemd user-unit sketch. Do **not** treat that as the venue path. Do **not** install Linux on the SER5 for this project.
