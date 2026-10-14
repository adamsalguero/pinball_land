# Pinball Land on the Beelink

About ten minutes. Windows 11 on the SER5. Do this once, then the wall comes back after a power cut.

## Before the command

In the SER5 BIOS, set **Auto Power On** (sometimes **Restore on AC Power**) to **On**. In Windows, turn on automatic sign-in: `Win+R`, `netplwiz`, uncheck **Users must enter a user name and password**. On each BenQ, set **Switch on state** to **On**.

Copy this repo to `C:\pinball-land` (git clone, or unzip a release there). Git for Windows is enough if the folder is not there yet.

## One command

Open PowerShell and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (-not (Test-Path C:\pinball-land\package.json)) { git clone https://github.com/adamsalguero/pinball_land.git C:\pinball-land }; & C:\pinball-land\scripts\install-beelink.ps1"
```

That installs Node.js LTS if it is missing, installs the app, registers the server and the wall to start at sign-in, opens the private-network firewall for ports 3000 and 3443, and starts the server. The window prints two addresses. The admin PIN is `2224`.

Sign out and back in once so the wall windows open on the TVs. The server is already running from the command above.

## Two home-screen apps

On the iPhone or iPad, join the venue WiFi. In Safari:

1. Open the **Guest** address (`http://<pc>:3000/`). Share, **Add to Home Screen**. The name is Pinball Land. Guests use this. There is no PIN.
2. Open the **Admin** address (`http://<pc>:3000/admin`). Share, **Add to Home Screen**. The name is Pinball Land Admin. Enter `2224` once. That iPad stays signed in.

Change the PIN under Admin, Settings. If it is forgotten: Admin, **Reset PIN to 2224**, or on the PC run `npm run reset-pin`, or use the kiosk tray item **Reset PIN to default**.

## After it is running

- Guest phones on the venue WiFi scan the QR on the Live Pinboard.
- A public guest link (Cloudflare Tunnel) is optional. Put the `https://` origin, with no path, in Admin under the photo public URL. The tunnel must send `CF-Connecting-IP` or `X-Forwarded-For`. Admin controls stay on the venue WiFi either way.
- More detail: [KIOSK.md](KIOSK.md), [CONTROL.md](CONTROL.md), [PHOTOS.md](PHOTOS.md).
