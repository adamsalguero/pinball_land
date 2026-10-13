# Videos on the wall

The kiosk plays files you put in `media/`. It does not download movies, cartoons, or music videos, and this repository does not ship any.

Upload from the iPad (**Videos** on the control page), or copy files into:

- `media/library` — general clips
- `media/halloween` — played in rotation while the Halloween theme is on
- `media/christmas` — played in rotation while the Christmas theme is on

Accepted types: `.mp4`, `.m4v`, `.webm`, `.mov`, `.mkv`, up to 8 GB. The upload is streamed to disk. Metadata (title, tags, all-ages, rotation, loop) is stored in `data/media-library.json`, which is not committed.

## All-ages

**All-ages** is on by default. New uploads are marked all-ages. Turn that flag off on a single clip to keep it out of rotation and block playback while the wall toggle is on. Turn the wall toggle off only when the room is not a family event. Tags are whatever you type (`snow`, `halloween`, `no-audio`). A clip in the library folder that is tagged `christmas` joins the Christmas rotation the same way a file in `media/christmas` does.

## Where clips may come from

Use something you have the right to play in a public venue. These are the sources to start from:

- **Public-domain films and cartoons.** In the United States, a useful starting point is the Library of Congress and films published before 1930, plus later works whose copyright expired. Prelinger collection material and other archive copies are often public domain or openly reusable. Read the item’s rights statement. A YouTube reupload is not the rights statement.
- **Pexels and Pixabay loops.** Both publish free stock video. Download the file they give you (a loop of lights, snow, a crowd walking, a pinball close-up) and keep their license page. Their licenses allow use in a business; they do not allow you to resell the clip as stock. Do not scrape random pages.
- **Swank Motion Pictures**, for commercial movies and studio clips. A bar or family entertainment center needs a **public performance license**. Swank is the usual licensor for that. The license, not the kiosk, is what makes showing a film legal. Buy the license, then play the copy Swank’s terms allow. Do not rip a disc or a streaming app and drop it in `media/`.

Do not add Disney, studio cartoons, trailers, or “holiday movie clips” ripped from the internet. A file being easy to find is not permission to play it on the wall.

## Playback

- **Play here** — the screen selected under Present.
- **Sync all** — the same file on every enabled TV, seeking to one shared start time. Only the left TV is unmuted.
- **Span all** — one picture cut across the wall (the video is widened and each TV shows its slice).
- **Rotation** — a clip marked “in rotation”, or a holiday clip while that theme is on, is a normal card. It loops until the rotation interval moves on. Rotation cards are muted so three TVs do not play three soundtracks.

The Electron kiosk turns on `PlatformHEVCDecoderSupport` and does not disable the GPU, so H.264 and HEVC can decode in hardware. H.264 plays on Windows 11 as installed. HEVC often needs the Microsoft Store package **HEVC Video Extensions**. 1080p and 4K both go through the same `<video>` element. If a file stays black, transcode it to H.264 yuv420p with AAC. That is the combination the SER5 plays without an extra codec pack.
