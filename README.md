# Pinball Land kiosk

Local web app for the triple-screen wall at Pinball Land (Pinnacle Entertainment Center). One Node process serves three display pages plus a phone/iPad control page on the same WiFi.

**Venue PC:** Beelink SER5, **Windows 11**, BIOS Auto Power On after AC loss. **Home PC:** Windows, `npm start` only. Ron drives it from an iPad. See **[KIOSK.md](KIOSK.md)** for the numbered always-on checklist.

## What you need

- Node.js 18+ ([nodejs.org](https://nodejs.org) — LTS, install for all users on the wall PC)
- Same WiFi as the iPad/phone
- Wall: `npm run kiosk`. Home testing: `npm start`

## Install and start (home / testing)

```bash
npm install
npm start
```

`npm start` is **server only**. It binds `0.0.0.0` and prints:

```
This PC control:     http://localhost:3000/
Phone / iPad:        http://192.168.1.42:3000/
Left display:        http://localhost:3000/display/1
...
```

Use the printed **Phone / iPad** address on Ron’s device. Default PIN is `1234`. Leave the terminal open. Ctrl+C stops it.

Open one display URL per monitor yourself when using `npm start`. You do not need three screens.

## Wall mode (every attached monitor)

```bash
npm install
npm run kiosk
```

This starts the server if it is not already running, then opens a frameless fullscreen window on each attached display, mapped **left-to-right** to `/display/1`, `/display/2`, `/display/3`. Extra monitors beyond three are ignored. The control page is **not** opened on the TVs. Mouse cursor is hidden on the display windows. Running kiosk again replaces previous display windows instead of stacking duplicates.

Venue always-on after a power blink: BIOS Auto Power On + Windows auto-logon + Task Scheduler. Details in [KIOSK.md](KIOSK.md). Also set BenQ **Switch on state = On** so the TVs wake with AC.

## Control page

- Fat buttons, phone-sized, thumb-friendly.
- Theme: **Pinnacle brand** (default, purple/charcoal/beige from the live site) or **Halloween party** (Ron toggles this; it is saved and does not follow the calendar).
- Each slot: Pinnacle Group logo, Entertainment Center logo, **photo collage** (arcade / bar / pool as small framed tiles — not stretched fullscreen), leaderboard, or black.
- Named events, typed-in scores, clear board. PIN default `1234`. Displays do not use the PIN.

Change PIN or port in `config.json` (`PORT` and `CONTROL_PIN` also work).

## Logos and venue photos

From [Pinnacle Group Financial Services](https://www.pinnaclegroupfinancial.com/) and [Pinnacle Entertainment Center](https://www.pinnaclegroupfinancial.com/pinnacle-entertainment-center):

- `public/logos/pinnacle.png`
- `public/logos/pinball-land.png`
- `public/photos/arcade.jpg`, `bar.jpg`, `pool.png`

Logos stay large and contained. Photos only appear as a collage of small frames on the brand background (the files are too low-res for a 55" TV edge-to-edge). Drop in higher-res files with the same names anytime.

## Persistence

Slot assignments, theme, and leaderboards save to `data/state.json`. Refresh and restart keep them.

## Out of scope

No serial/RS232, no BenQ serial control, no Home Assistant, no smart plugs, no live pinball scores, no animations.
