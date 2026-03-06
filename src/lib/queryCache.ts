interface QueryCacheEntry<T> {
  expiresAt: number;
  value?: T;
  promise?: Promise<T>;
}

const queryCache = new Map<string, QueryCacheEntry<unknown>>();

interface QueryOptions {
  force?: boolean;
}

export async function getCachedQuery<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  options: QueryOptions = {},
): Promise<T> {
  if (options.force) {
    queryCache.delete(key);
  }

  const existing = queryCache.get(key) as QueryCacheEntry<T> | undefined;
  const now = Date.now();

  if (existing?.value !== undefined && existing.expiresAt > now) {
    return existing.value;
  }

  if (existing?.promise) {
    return existing.promise;
  }

  const promise = loader()
    .then((value) => {
      queryCache.set(key, {
        expiresAt: Date.now() + ttlMs,
        value,
      });
      return value;
    })
    .catch((error) => {
      queryCache.delete(key);
      throw error;
    });

  queryCache.set(key, {
    expiresAt: existing?.expiresAt ?? 0,
    value: existing?.value,
    promise,
  });

  return promise;
}

export function invalidateCachedQuery(prefix: string): void {
  for (const key of queryCache.keys()) {
    if (key.startsWith(prefix)) {
      queryCache.delete(key);
    }
  }
}

export function clearCachedQueries(): void {
  queryCache.clear();
}
