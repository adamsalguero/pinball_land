function mapDisplaysToSlots(displays) {
  return [...(displays || [])]
    .sort((a, b) => {
      const ax = a.bounds?.x ?? 0;
      const bx = b.bounds?.x ?? 0;
      if (ax !== bx) return ax - bx;
      return (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0);
    })
    .slice(0, 3)
    .map((display, index) => ({
      slot: index + 1,
      bounds: display.bounds,
      id: display.id,
    }));
}

module.exports = { mapDisplaysToSlots };
