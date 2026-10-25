(function (root) {
  let loadedBuild = null;

  function watchBuild(build) {
    if (!build || root.__pinballReloading) return false;
    const next = String(build);
    if (loadedBuild === null) {
      loadedBuild = next;
      return false;
    }
    if (next === loadedBuild) return false;
    root.__pinballReloading = true;
    if (root.location && typeof root.location.reload === "function") root.location.reload();
    return true;
  }

  root.PinballBuild = { watchBuild };
})(typeof globalThis !== "undefined" ? globalThis : window);
