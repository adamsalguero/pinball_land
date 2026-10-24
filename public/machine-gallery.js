(function () {
  const PLACEHOLDER = "/cabinet-placeholder.png";
  let root = null;
  let input = null;
  let results = null;
  let onPick = null;
  let timer = null;
  let requestId = 0;

  function close() {
    if (!root) return;
    root.hidden = true;
    input.value = "";
    results.replaceChildren();
    onPick = null;
    clearTimeout(timer);
  }

  function ensure() {
    if (root) return;
    root = document.createElement("div");
    root.id = "machine-gallery";
    root.className = "machine-gallery";
    root.hidden = true;
    const sheet = document.createElement("div");
    sheet.className = "machine-gallery-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Search machines");
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "machine-gallery-close";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", close);
    input = document.createElement("input");
    input.type = "search";
    input.setAttribute("aria-label", "Search machines");
    input.placeholder = "Jaws";
    input.autocomplete = "off";
    results = document.createElement("div");
    results.className = "machine-gallery-grid";
    sheet.append(closeButton, input, results);
    root.append(sheet);
    root.addEventListener("click", (event) => {
      if (event.target === root) close();
    });
    document.body.append(root);
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) {
        results.replaceChildren();
        return;
      }
      timer = setTimeout(() => search(q), 280);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && root && !root.hidden) close();
    });
  }

  function paint(items) {
    results.replaceChildren();
    for (const item of items) {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "machine-gallery-tile";
      const img = document.createElement("img");
      img.alt = "";
      img.src = `/api/opdb/cabinet/${encodeURIComponent(item.opdbId)}`;
      img.addEventListener("error", () => {
        if (img.dataset.fallback === "1") return;
        img.dataset.fallback = "1";
        img.src = PLACEHOLDER;
      });
      const name = document.createElement("strong");
      name.textContent = item.name || "";
      const meta = document.createElement("span");
      meta.textContent = [item.manufacturer, item.year, item.edition].filter(Boolean).join(" · ");
      tile.append(img, name, meta);
      tile.addEventListener("click", () => {
        const pick = onPick;
        close();
        if (pick) pick(item);
      });
      results.append(tile);
    }
  }

  async function search(q) {
    const token = ++requestId;
    try {
      const res = await fetch(`/api/opdb/search?q=${encodeURIComponent(q)}`);
      const data = await res.json().catch(() => ({}));
      if (token !== requestId || !root || root.hidden) return;
      paint(res.ok && Array.isArray(data.results) ? data.results : []);
    } catch {
      if (token === requestId) paint([]);
    }
  }

  window.PinballGallery = {
    open({ onPick: pick } = {}) {
      ensure();
      onPick = typeof pick === "function" ? pick : null;
      requestId += 1;
      input.value = "";
      results.replaceChildren();
      root.hidden = false;
      input.focus();
    },
  };
})();
