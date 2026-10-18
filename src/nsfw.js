let state = "idle";
let model = null;
let loading = null;

async function loadModel() {
  if (state === "off") return null;
  if (model) return model;
  if (loading) return loading;
  loading = (async () => {
    try {
      require("@tensorflow/tfjs-node");
      const nsfw = require("nsfwjs");
      model = await nsfw.load();
      state = "ready";
      return model;
    } catch (err) {
      state = "off";
      console.warn(`NSFW check unavailable (${err.message || "model"}). Photos post without it.`);
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function checkImage(buffer) {
  if (state === "off") return { checked: false, flagged: false };
  const ready = await loadModel();
  if (!ready) return { checked: false, flagged: false };
  try {
    const tf = require("@tensorflow/tfjs-node");
    const image = tf.node.decodeImage(buffer, 3);
    const predictions = await ready.classify(image);
    image.dispose();
    const flagged = (predictions || []).some((item) => {
      const name = String(item.className || "");
      return (name === "Porn" || name === "Hentai") && Number(item.probability) >= 0.7;
    });
    return { checked: true, flagged };
  } catch (err) {
    console.warn(`NSFW check skipped (${err.message || "classify"}).`);
    return { checked: false, flagged: false };
  }
}

module.exports = { checkImage };
