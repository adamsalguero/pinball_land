# Photos

Guests post from the Pinball Land app at `/`. The server resizes each photo with sharp, bakes in orientation, and drops EXIF, including GPS. Phone photos stay card-size on the wall.

The Live Pinboard is the default wall card. New photos drop, tilt, and glow. Collage mode is the quieter alternative, switched in admin under Photos. Span keeps one board continuous across the enabled screens.

Auto-approve is off until an admin turns it on. Approve and reject are on the Photos tab. Download a zip of an event, or clear that event, from the photo API.

A public base URL is optional for a Cloudflare Tunnel when guest phones are not on the venue WiFi. The wall QR uses that URL when it is set.

Guest photos are stored in the data directory, not in the app folder.
