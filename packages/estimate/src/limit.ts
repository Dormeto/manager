// At most `limit` calls of fn at a time over items, the results in the items' order (the estimate's AWS reads:
// --parallel accounts or regions, a region's workloads).
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  }));
  return out;
}
