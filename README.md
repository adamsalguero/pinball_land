# Pinball Land kiosk

Local web app for the screen wall at Pinball Land (Pinnacle Entertainment Center). One Node process serves up to three display pages, a guest app, and an admin app on the same WiFi. The wall can run 1, 2, or 3 screens. Guests can present on one of them. The Beelink path is **[QUICKSTART.md](QUICKSTART.md)**. Presenting is **[PRESENTING.md](PRESENTING.md)**.

**Venue PC:** Beelink SER5, **Windows 11**, BIOS Auto Power On after AC loss. **Home PC:** Windows, `npm start` only. Ron drives it from an iPad. See **[KIOSK.md](KIOSK.md)** for the numbered always-on checklist.

## What you need

- Node.js 18+ ([nodejs.org](https://nodejs.org) — LTS, install for all users on the wall PC)
- Same WiFi as the iPad/phone
- Wall: `npm run kiosk`. Home testing: `npm start`
- Optional: a free [OPDB](https://opdb.org) API token if you want pinball backglass art cached for the wall

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
Center display:      http://127.0.0.1:3000/display/2
Right display:       http://[::1]:3000/display/3
...
```

Use the printed **Admin** address on Ron’s device (`/admin`). Default PIN is `2224`. Guests use `/` with no PIN. Leave the terminal open. Ctrl+C stops it.

Open one display URL per monitor yourself when using `npm start`. You do not need three screens.

## Wall mode (enabled monitors)

```bash
npm install
npm run kiosk
```

This starts the server if it is not already running, then opens a frameless fullscreen window for each **enabled** display, mapped **left-to-right** to `/display/1`, `/display/2`, `/display/3`. The control page’s **Displays** section sets the count (1–3), which screens are on, what each one shows, and an optional mirror of screen 1 onto the others. A manual monitor order is there too. Extra monitors beyond the count are ignored. If a configured screen has no monitor, that window is skipped and the terminal says so. The control page is **not** opened on the TVs. Mouse cursor is hidden on the display windows. Running kiosk again replaces previous display windows instead of stacking duplicates. Count and order apply live; **Restart kiosk windows** forces a reopen.

Venue always-on after a power blink: BIOS Auto Power On + Windows auto-logon + Task Scheduler. Details in [KIOSK.md](KIOSK.md). Also set BenQ **Switch on state = On** so the TVs wake with AC.

## Control page

- Fat buttons, phone-sized, thumb-friendly.
- Theme: **Pinnacle brand** (default, purple/charcoal/beige from the live site, **Lato** 400/700), **Halloween party**, or **Christmas**. Ron toggles these; they are saved and do not follow the calendar. Halloween and Christmas also rotate family clips from `media/halloween` and `media/christmas`. See **[MEDIA.md](MEDIA.md)**.
- **Wall rotation is on by default.** Every TV shares one playlist (Pinnacle Group logo, Entertainment Center logo, three amenity cards, and each enabled leaderboard). Screens are staggered so neighbors are not on the same card. Interval defaults to 14 seconds.
- Rotation on/off, interval, and per-item toggles live on the control page. Turning rotation off lets you assign each TV by hand.
- **Off** blacks every screen immediately. **Resume wall** brings the playlist back. Off does not wipe the playlist.
- Amenities (site wording, never “pool”): **2-story arcade**, **Outdoor Oasis**, **Flexible Event Options**. Photos stay in a small frame on the brand background.
- Named events, typed-in scores, pinball machines from OPDB (or by name). Admin PIN default `2224`. Displays and the guest app do not use the PIN.

Change PIN, port, or OPDB token in `config.json` (`PORT`, `CONTROL_PIN`, `HTTPS_PORT`, and `OPDB_API_KEY` also work). Display count, per-screen layout, and presentation idle time are edited on the control page and saved in that same file.

**Present** on the control page sends one screen to a guest share, a URL, or an uploaded PDF/image. **AirPlay** is a separate one-tap target (one TV, or the same mirror on all three). The receiver stays running. Steps: [PRESENTING.md](PRESENTING.md).

**Smart plugs** discover Kasa outlets on the LAN and map them to the three TVs. Do not put the PC on a plug. **Videos** upload into `media\` (large files stream to disk) and can play on one screen, synced, or spanned. Hardware decode is on in the kiosk. See [KIOSK.md](KIOSK.md) and [MEDIA.md](MEDIA.md).

## Logos and amenity photos

From [Pinnacle Group Financial Services](https://www.pinnaclegroupfinancial.com/) and [Pinnacle Entertainment Center](https://www.pinnaclegroupfinancial.com/pinnacle-entertainment-center):

- `public/logos/pinnacle.svg` — Pinnacle Group Financial Services
- `public/logos/pinball-land.svg` — Pinnacle Entertainment Center
- `public/photos/arcade.jpg` — 2-story arcade
- `public/photos/oasis.jpg` — Outdoor Oasis (the waterfall/garden photo; not a pool)

Displays prefer the SVG lockups. Lettering is converted to paths so the wall does not need those mark fonts installed. UI copy uses Lato.

Logos stay large and contained. Amenity photos only appear as a small framed image next to the headline and body (never stretched fullscreen).

## Pinball collection (OPDB)

From the control page, search machines on [Open Pinball Database](https://opdb.org), add them to the collection, and enable that machine’s leaderboard. Enabled boards join the wall rotation. The card shows cached backglass / translite / banner art (`object-fit: contain`) plus typed-in scores.

A free API token is required to download machine JSON and art (account + token on opdb.org). Put it in `config.json` as `opdbApiKey`, or set `OPDB_API_KEY`. Files cache under `data/opdb/` so a WiFi blip does not blank the wall. Without a token, search still works (typeahead) and you can add a machine by name so a party is not blocked; art appears after a token is added and the machine is re-added from search.

If an OPDB entry includes a direct `.mp4` / `.webm` trailer URL, the machine card may loop it muted. YouTube is not scraped.

## Persistence

Rotation, theme, blackout, leaderboards, and machine collection save to `data/state.json`. Refresh and restart keep them. OPDB caches live in `data/opdb/` (gitignored).

## Out of scope

No serial/RS232, no BenQ serial control, no Home Assistant, no smart plugs, no live pinball scores, no animations.
