const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

// 320x240 PNG. Guest ingest rejects anything smaller, and this file does not depend on sharp to exist.
const FIXTURE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAAD+Tyo8AAACD0lEQVR42u3TQQkAAAgEwYtjJtMZ1Q7+hIFJsLCpHuCpSAAGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGAysAhgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMHC3OXDr3tlSwmUAAAAASUVORK5CYII=",
  "base64"
);

async function main() {
  const appRoot = path.resolve(process.argv[2] || "");
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "pinball-upload-"));
  const tempRoot = path.resolve(os.tmpdir());
  if (temp !== tempRoot && !temp.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error("upload self-check temp dir escaped the system temp folder");
  }
  try {
    const { createRequire } = require("module");
    const { GuestAlbum } = require(path.join(appRoot, "src", "photos.js"));
    const sharp = createRequire(path.join(appRoot, "package.json"))("sharp");
    const album = new GuestAlbum({ root: temp, sharpImpl: sharp });
    const photo = await album.ingest(FIXTURE_PNG, {
      caption: "self-check",
      guestName: "install",
      autoApprove: true,
      ip: "upload-self-check",
    });
    const file = path.join(temp, "files", `${photo.id}.jpg`);
    const stat = await fsp.stat(file);
    if (!stat.size || !photo.width || !photo.height) throw new Error("upload self-check wrote an empty photo");
    process.stdout.write(`${JSON.stringify({ ok: true, detail: `upload path ok (${stat.size} bytes)` })}\n`);
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(async (err) => {
  let cause = err && err.cause && err.cause.message ? `: ${err.cause.message}` : "";
  if (!cause) {
    try {
      const { createRequire } = require("module");
      const sharp = createRequire(path.join(path.resolve(process.argv[2] || ""), "package.json"))("sharp");
      await sharp(FIXTURE_PNG).metadata();
    } catch (raw) {
      cause = `: ${raw && raw.message ? raw.message : raw}`;
    }
  }
  const detail = `upload path failed: ${err && err.message ? err.message : err}${cause}`.slice(0, 400);
  process.stdout.write(`${JSON.stringify({ ok: false, detail })}\n`);
  process.exit(1);
});
