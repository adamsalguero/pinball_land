# Kiosk wall (Windows 11 + BIOS)

Supported venue PC: **Beelink SER5** running **Windows 11** (the image it ships with). Adam’s home PC is also Windows. Do **not** install Linux for this wall.

`npm start` is server-only (home testing). `npm run kiosk` starts the server if needed and opens a frameless fullscreen window on every attached monitor, left-to-right: `/display/1`, `/display/2`, `/display/3`. The control page stays on the phone/iPad.

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

   Confirm a fullscreen display window on each monitor, left to right. Control from a phone at the printed LAN URL (`http://<pc-ip>:3000/`, PIN `1234`).
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

8. Firewall: when Windows asks, **allow Node.js** on private networks, port **3000**. Or:

   ```powershell
   netsh advfirewall firewall add rule name="Pinball Land kiosk" dir=in action=allow protocol=TCP localport=3000
   ```

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

Open `http://localhost:3000/display/1` (and `/display/2` on a second monitor if you have one). Control from `/` or a phone on the same WiFi. Optional: `npm run kiosk` if you want to try auto-fullscreen on the monitors you have.

---

## Appendix: Ubuntu 24.04 (optional, not supported)

If someone later puts Ubuntu on a box, `scripts/kiosk.service` and `scripts/ubuntu-kiosk-setup.sh` print a systemd user-unit sketch. Do **not** treat that as the venue path. Do **not** install Linux on the SER5 for this project.
