const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { loadCatalog } = require("../src/catalog");

const root = path.join(__dirname, "..");
const catalog = loadCatalog(path.join(root, "media", "catalog.json"));
const maxBytes = Number(process.env.PINBALL_MEDIA_MAX_BYTES || 1_500_000_000);

async function download(item, dest) {
  const partial = `${dest}.partial`;
  let have = 0;
  if (fs.existsSync(partial)) have = fs.statSync(partial).size;
  if (fs.existsSync(dest)) {
    console.log(`already have ${item.id}`);
    return;
  }
  if (item.bytes && item.bytes > maxBytes) {
    console.log(`skip ${item.id}: ${item.bytes} bytes is above the download cap. It still streams from ${item.streamUrl}`);
    return;
  }
  const headers = {};
  if (have) headers.Range = `bytes=${have}-`;
  const res = await fetch(item.streamUrl, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`${item.id} ${res.status}`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const file = fs.createWriteStream(partial, { flags: have && res.status === 206 ? "a" : "w" });
  const reader = res.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    file.write(Buffer.from(chunk.value));
  }
  await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())));
  await fsp.rename(partial, dest);
  console.log(`saved ${dest}`);
}

async function main() {
  for (const item of catalog) {
    const ext = path.extname(new URL(item.streamUrl).pathname) || ".webm";
    const dest = path.join(root, "media", item.holiday, `${item.id}${ext}`);
    await download(item, dest);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
