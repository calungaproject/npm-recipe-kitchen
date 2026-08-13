export class DeclarationMismatchError extends Error {
  constructor({ added, missing }) {
    super('Declaration mismatch: requires_tl_packages does not match direct_required');
    this.name = 'DeclarationMismatchError';
    this.added = added;
    this.missing = missing;
  }
}

export function deriveCompliance({ consumer, directProduction, productionClosure, catalog, requiresTlPackages }) {
  const directRequired = [...directProduction].sort();

  if (requiresTlPackages) {
    const directSet = new Set(directRequired);
    const tlSet = new Set(requiresTlPackages);

    const added = directRequired.filter(id => !tlSet.has(id)).sort();
    const missing = [...requiresTlPackages].filter(id => !directSet.has(id)).sort();

    if (added.length > 0 || missing.length > 0) {
      throw new DeclarationMismatchError({ added, missing });
    }
  }

  const closureGaps = productionClosure.filter(id => !catalog.isAvailable(id)).sort();
  const directGaps = directRequired.filter(id => !catalog.isAvailable(id));

  let level;
  if (closureGaps.length === 0) {
    level = 'L3';
  } else if (directGaps.length === 0) {
    level = 'L2';
  } else {
    level = 'L1';
  }

  const report = {
    schema_version: 1,
    consumer,
    direct_required: directRequired,
    production_closure: [...productionClosure].sort(),
    closure_gaps: closureGaps,
  };

  return { report, level };
}
