# Presenting on a Pinball Land screen

Ron drives this from the iPad. Guests never install an app. Everything stays on the venue WiFi. The admin app is PIN-protected (`2224` until you change it). Guests use the Pinball Land app with no PIN. See [CONTROL.md](CONTROL.md).

One screen presents. The others keep rotating.

---

## Before a party

1. The wall PC and the iPad are on the same WiFi. Guest phones and laptops join that WiFi too. **Guest isolation / AP isolation must be off**, or phones will not see the PC.
2. On the iPad, open the control page (`http://<wall-pc>:3000/`) and enter the PIN.
3. Under **Displays**, set how many TVs are on (1, 2, or 3) and leave the ones you want enabled.
4. Under **Present**, set **End a presentation after this many idle minutes**. Default is 10. A browser share stays up while the laptop is actually sharing. A URL, a file, or AirPlay ends after that many minutes unless someone taps **Keep showing**.
5. **Off — black all screens** still blacks every TV, including a presentation.

---

## Start a presentation (every method)

1. On the iPad, open **Present**.
2. Tap the screen: **Left**, **Center**, or **Right** (names follow the display count).
3. Pick the method below.
4. That TV switches. The others keep rotating.
5. Tap **End presentation** when the guest is done. The TV goes back to rotation.

---

## A. Browser share (laptop, Android, Chrome)

Use this for a PowerPoint, a browser tab, or a whole laptop screen. No install.

iPhone and iPad **cannot** do this. Safari will not share its own screen. Those guests use AirPlay (method B).

### One-time on the wall PC

The first `npm start` or `npm run kiosk` creates a certificate and listens on **https://<wall-pc>:3443**. Browsers only allow screen share from an https page.

1. Allow Node.js through the Windows firewall on **private** networks for ports **3000** and **3443** (see KIOSK.md).
2. On a laptop, open `https://<wall-pc>:3443/present` once.
3. Chrome or Edge shows a warning because the certificate is local, not from a public authority. Choose **Advanced** → **Proceed** (wording varies). You only do this once per browser.

If the PC’s WiFi address changes, restart the kiosk so the certificate includes the new address, then accept the warning again.

### Each time a guest shares

1. On the iPad, select the TV and tap **Browser share**.
2. That TV shows a 4-digit code and the https address.
3. On the laptop or Android phone, open that https address (`/present`).
4. Type the code. Tap **Share screen or tab**.
5. The browser asks what to share. Pick a tab, a window, or the whole screen.
6. The TV shows it. Leave the guest’s page open.
7. Stop from the guest page (**Stop sharing**) or from the iPad (**End presentation**).

Chrome on Android can share the phone’s screen. It cannot share a single tab the way a laptop can. That is a Chrome limit.

The laptop and the wall PC must be on the same WiFi. There is no internet relay.

---

## B. AirPlay (iPhone, iPad, Mac)

Apple devices mirror with AirPlay. The wall PC keeps **UxPlay** running, so the receiver is already on the network. You do not start it per guest.

### One-time setup on the wall PC (Windows 11)

Upstream [UxPlay](https://github.com/FDH2/UxPlay) does not publish a Windows exe. This project downloads the x64 build from [leapbtw/uxplay-windows 2.0.0.1736](https://github.com/leapbtw/uxplay-windows/releases/tag/2.0.0.1736) and Apple’s Bonjour Print Services installer. Both downloads are checked against SHA-256 before they are used. The ARM64 zip is not used.

In an **Administrator** PowerShell, from the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-airplay-windows.ps1
```

That script:

1. Downloads `uxplay-windows.zip` and checks SHA-256 `9d3a51c15fc9db857351195e7eb7bbb21700d9ae25d936a54bcf8536b62cca18`.
2. Unpacks it to `tools\uxplay-windows\`. The kiosk finds `uxplay*.exe` there on its own.
3. Downloads [Bonjour Print Services 2.0.2](https://download.info.apple.com/Mac_OS_X/061-8098.20100603.gthyu/BonjourPSSetup.exe) (Apple’s page: [Bonjour Print Services for Windows](https://support.apple.com/en-us/106380)) and checks SHA-256 `7f1ec347cd429cfb25a34b2147e02231334f28290e0c28be213415b0f99da1a0`.
4. Installs Bonjour quietly if the window is elevated.

The 2.0 build also bundles mDNSResponder, so an iPhone can still see the receiver if Bonjour’s installer complains. Install Bonjour anyway. The exe is unsigned: if SmartScreen appears, choose **More info**, then **Run anyway**.

Allow **uxplay** and **Node.js** on private networks when Windows Firewall asks. AirPlay uses Bonjour (UDP 5353) plus the ports UxPlay opens (TCP 7000 and nearby UDP).

Restart the kiosk (`npm run kiosk`). The server starts UxPlay and leaves it running. The name iPhones see is **Pinball Land** (`airplay.windowTitle`).

To point at a different exe, set `airplay.command` in `config.json`. Extra flags in `args` are added after `-n`, `-nh`, `-s`, and on Windows `-vs d3d11videosink`. Do not add `-fs`. Fullscreen mode sticks to the primary monitor. The kiosk moves the window itself.

### Each time an iPhone mirrors

1. On the iPad, under **AirPlay**, tap the TV once: **Left**, **Center**, **Right**, or **All three**. **Off** clears the choice. That is the whole setup. The screens stay on rotation until a phone actually connects.
2. On the iPhone or Mac: Control Center → **Screen Mirroring** → **Pinball Land**.
3. The kiosk notices the session (UxPlay’s log, or the video window appearing after it had been absent). The chosen TV leaves rotation and shows the mirror. The other TVs keep rotating.
4. **All three** is still one AirPlay session. UxPlay’s window goes on the left TV. The center and right TVs copy that screen. It is the same picture on each TV, not three separate receivers.
5. When the phone stops mirroring, those TVs return to rotation. You can also tap **Off**, or **End presentation** if the mirror card is already up. UxPlay itself stays running for the next guest.

If the video lands on the wrong monitor, set **Monitor order** under Displays so Left/Center/Right match the wall, then tap the target again.

### Paid fallback: AirServer

[AirServer](https://www.airserver.com/) for Windows is the paid receiver. Install it, set its name to Pinball Land, and put its `.exe` in `airplay.command`. The kiosk launches that program and tries to place its largest window on the chosen TV. The kiosk does not include a license.

---

## C. Google Cast

A real Google Cast receiver on Windows is not practical. There is no Cast app in this project, and none is coming.

- **Chrome laptop or Android Chrome:** use method A (browser share).
- **Cast-only devices:** plug a Chromecast or Google TV dongle into a **spare HDMI input on the TV** (not into the PC). Put the dongle on the same WiFi. The guest casts to the dongle’s name. Switch the TV back to the PC’s HDMI input when they are done. That dongle bypasses the kiosk for as long as the TV is on that input. The other TVs are unaffected only if the dongle is on one TV.

---

## Show a web page

1. Select the TV.
2. Paste an `https://` or `http://` address.
3. Tap **Show this URL**.

The TV loads it in a frame. Some sites refuse to be embedded (they send “don’t frame me”). Those sites stay blank. Use browser share for those, or open a page that allows embedding.

`javascript:` and `file:` addresses are rejected.

---

## Show a PDF or a picture

1. Select the TV.
2. Choose a PNG, JPEG, WEBP, GIF, or PDF from the iPad (20 MB max).
3. Tap **Show PDF or image**.

Photos are letterboxed. PDFs use the TV’s built-in PDF viewer. The file is deleted when the presentation ends.

---

## Idle time and Keep showing

- Browser share: the clock resets while the guest page is still connected. If they close the laptop, the TV returns to rotation after the idle minutes.
- AirPlay, a URL, or a file: the clock starts when you tap start. Tap **Keep showing** on the iPad to reset it. Otherwise the TV returns to rotation by itself so a deck is not left up all night.

---

## What this cannot do

- iPhone or iPad Safari cannot share its screen into the browser page. Use AirPlay.
- No Google Cast receiver on the PC.
- Browser share needs https and the one-time certificate warning. Plain `http://` will not show the screen picker.
- Guest and wall PC must be on the same LAN. Client isolation on the WiFi breaks both browser share and AirPlay.
- AirPlay needs UxPlay (or AirServer) and Bonjour installed ahead of time. The kiosk does not download them.
- One AirPlay receiver at a time.
- A URL that forbids framing will not appear. Share the tab instead.
- The 4-digit code is visible on the TV and to anyone already on the venue WiFi. Do not put this PC on the public internet.
- Presenting does not change the other screens’ rotation.
