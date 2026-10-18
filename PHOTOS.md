# Photos

Guests post from the Pinball Land app at `/`. The server resizes each photo with sharp, bakes in orientation, and drops EXIF, including GPS. Phone photos stay card-size on the wall.

The Live Pinboard is the default wall card. New photos drop, tilt, and glow. Collage mode is the quieter alternative, switched in admin under Photos. Span keeps one board continuous across the enabled screens.

The Photos tab is the only Auto-approve switch. It is on unless an admin turns it off. There is no second copy under Settings. Approve and reject for anything still waiting are on that same Photos tab, next to Pause uploads and Delete. Download a zip of an event, or clear that event, from the photo API.

Every upload is re-encoded to JPEG, stripped of EXIF and GPS, and limited in size. Captions and names are shortened and words are masked. One guest can post 6 photos in 10 minutes and 30 in a day. A local check can hold a photo for approval even while Auto-approve is on. If that check cannot load, the photo follows the switch.

A public base URL is optional for a Cloudflare Tunnel when guest phones are not on the venue WiFi. Use the `https://` origin with no path. The wall QR uses that URL when it is set. The tunnel must send `CF-Connecting-IP` or `X-Forwarded-For`. Guest upload stays open. Admin, the PIN, plugs, and share codes stay on the venue network.

Guest photos are stored in the data directory, not in the app folder.
