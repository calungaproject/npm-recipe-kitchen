export function createCatalog(catalogJson) {
  const entries = new Map();
  for (const [identity, entry] of Object.entries(catalogJson.entries)) {
    entries.set(identity, entry.available);
  }

  return {
    isAvailable(identity) {
      return entries.get(identity) === true;
    },
  };
}
