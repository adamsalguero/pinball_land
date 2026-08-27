# Pinball Land kiosk

A small local web app for the triple-screen wall at Pinball Land. One Node process serves three fullscreen display pages plus a phone/iPad control page on the same WiFi.

Adam can run this on a home PC with 1 or 2 monitors tonight. Later the same app runs on a mini PC attached to three TVs. Ron drives it from an iPad or phone. No extra GPU, no serial/TV-brand control, and no live machine scores — just logos, typed-in leaderboards, and a black/off state.

## What you need

- Node.js 18 or newer ([nodejs.org](https://nodejs.org))
- A computer on the venue (or home) WiFi
- A browser on each screen, plus a phone or iPad on the **same WiFi**

## Install and start

In a terminal, from this folder:

```bash
npm install
npm start
```

The app binds to `0.0.0.0` so other devices on the LAN can reach it. On start it prints URLs like:

```
This PC control:     http://localhost:3000/
Phone / iPad:        http://192.168.1.42:3000/
Left display:        http://localhost:3000/display/1
Center display:      http://localhost:3000/display/2
Right display:       http://localhost:3000/display/3
```

Use the printed **Phone / iPad** address, not `localhost`, on Ron’s device. Default control PIN is `1234`.

Leave this terminal open while the kiosk is running. Ctrl+C stops it.

## Home PC (1 or 2 monitors)

You do **not** need three physical screens.

1. Start the app with `npm start`.
2. On monitor 1, open `http://localhost:3000/display/1` (left).
3. On monitor 2, drag a second browser window to that screen and open `http://localhost:3000/display/2` (center).
4. Optionally open display 3 in any extra window to preview the right slot.
5. Open `http://localhost:3000/` on this PC, or the printed LAN URL on your phone, to control them.

To fullscreen a display window: press **F11**, or in Chrome use the browser menu → Full screen. In Chrome you can also start a window as an app:

```bash
chrome --kiosk http://localhost:3000/display/1
```

(On Windows, point that at your Chrome shortcut / `chrome.exe`. On macOS the binary is usually `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.)

## Venue: three TVs and an iPad

1. Plug the mini PC into the three TVs (left / center / right).
2. Run `npm start` on the mini PC.
3. Open `/display/1`, `/display/2`, and `/display/3` fullscreen on the matching TVs.
4. On the iPad or phone (same WiFi), open the printed `http://<lan-ip>:3000/` URL.
5. Unlock with the PIN. Assign each slot: Pinnacle Group, Entertainment Center, Arcade / Bar / Pool photos, a leaderboard, or black.
6. **Off — black all screens** sets every slot to black immediately. Displays update live; they do not need a refresh.

If the phone cannot load the page: confirm it is on the same WiFi, use the printed LAN IP (not localhost), and allow Node / port 3000 through the PC firewall if Windows asks.

## Control page

- Fat buttons, phone-sized layout, thumb-friendly.
- Change what each of the three slots shows.
- Create named events (for example “Halloween party”).
- Add / edit / reorder / delete player rows. Scores are typed in by a person.
- Clear a whole board, or delete an event.
- Optional PIN (default `1234`) so random guests cannot drive it. Display pages do not use the PIN.

Change the PIN or port in `config.json`:

```json
{
  "port": 3000,
  "pin": "1234"
}
```

You can also override with environment variables: `PORT` and `CONTROL_PIN`.

## Logos and venue photos

Artwork lives in `public/logos/` and `public/photos/`, taken from Pinnacle Group Financial Services / Pinnacle Entertainment Center branding:

- `public/logos/pinnacle.png` — Pinnacle Group Financial Services
- `public/logos/pinball-land.png` — Pinnacle Entertainment Center
- `public/photos/arcade.jpg` — pinball arcade
- `public/photos/bar.jpg` — indoor bar / lounge
- `public/photos/pool.png` — outdoor pool

Each TV slot can show either logo, any venue photo, a leaderboard, or black. To swap in higher-resolution files later, drop replacements with those same names (`png`, `jpg`, or `webp`). See `public/logos/REPLACE_THESE.txt` and `public/photos/REPLACE_THESE.txt`. Refresh the display pages after replacing a file.

## Persistence

Current slot assignments and leaderboards are saved to `data/state.json`. A browser refresh or an `npm start` restart keeps the same boards and screen assignments.

## Out of scope (on purpose)

No serial/RS232, no BenQ-specific control, no Home Assistant, no smart plugs, no live pinball machine scores, and no animations.
