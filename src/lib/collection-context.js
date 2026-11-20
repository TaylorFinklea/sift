export function collectionForRun(run, collections) {
  const collection = collections.find((item) => item.id === run?.collectionId);
  if (collection) return collection;
  return run?.collectionName ? { name: run.collectionName } : null;
}
