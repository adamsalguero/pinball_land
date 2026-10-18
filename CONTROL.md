# Control

Two apps are served by the kiosk. Both are installable from Safari with Add to Home Screen.

## Pinball Land (guests)

Open `http://<kiosk>:3000/` or `/app`. There is no PIN.

Guests can take a photo with the camera, pick one from the library, add a name and caption, and post. Photos wait in the admin queue unless auto-approve is on. The same page shows the live pinboard and tonight’s event scores.

The QR on the Live Pinboard screen points here. If phones are on cellular, set a public base URL (Cloudflare Tunnel) in admin settings so the QR is not a private LAN address.

## Pinball Land Admin

Open `http://<kiosk>:3000/admin` on the venue WiFi. The default PIN is `2224`. Change it under Settings. It is a convenience gate, not a lock. Admin pages and admin APIs answer only on the venue WiFi or on this PC. A Tailscale Funnel or Cloudflare tunnel request gets 404 for admin, the displays, plugs, and `/api/state`. The public URL is the guest app only, on port 3010.

Entering the PIN once creates a long-lived device token. The browser stores it in an httpOnly cookie and in localStorage, so a Home Screen app opens without asking again.

The top bar has **Guest app**, **TVs On/Off**, and **Lock**. **TVs On/Off** switches every assigned Kasa plug together and confirms in a short message. Transitions stay on. There is no separate transitions control.

Reset the PIN from an admin device, from the kiosk tray (**Reset PIN to default**), with `npm run reset-pin` on the kiosk PC, or by deleting the `pin` key in the data-dir `config.json`. The default comes back as `2224`. The running server reads that file on the next login.

## Data

Mutable files live outside the app folder: `C:\ProgramData\PinballLand` on Windows, or `~/.pinball-land` elsewhere. `PINBALL_DATA_DIR` overrides that. Updates never write into that folder.
