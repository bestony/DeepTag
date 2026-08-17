/**
 * Bounded, expiring set of idempotency keys.
 *
 * `claim` is a check-and-set, not a query: it returns true only for the first
 * caller to present a key. Node runs it on one thread, so the check and the
 * insert cannot interleave — which is what makes it safe to call before kicking
 * off detached async work, where a plain "has then later add" would let two
 * concurrent deliveries both slip through.
 */

export type SeenSetOptions = {
  /** Hard cap on retained keys; the oldest are dropped beyond it. */
  readonly maxEntries: number;
  /** How long a key stays claimed. Measured from the first claim, not the last. */
  readonly ttlMs: number;
  /** Injectable clock so tests can drive expiry without sleeping. */
  readonly now?: () => number;
};

export type SeenSet = {
  /** True if this call claimed the key, false if it was already claimed. */
  claim(key: string): boolean;
  size(): number;
};

export const createSeenSet = ({ maxEntries, ttlMs, now = Date.now }: SeenSetOptions): SeenSet => {
  /** key -> time of first claim. */
  const claimed = new Map<string, number>();

  const expire = (currentTime: number): void => {
    // Keys are inserted once and never re-inserted, so Map's insertion order is
    // also claim-time order: the first still-fresh entry means the rest are too.
    for (const [key, claimedAt] of claimed) {
      if (currentTime - claimedAt <= ttlMs) {
        break;
      }
      claimed.delete(key);
    }
  };

  // Runs after the insert, not before, so `size()` never exceeds `maxEntries`.
  const trimToCapacity = (): void => {
    while (claimed.size > maxEntries) {
      const oldest = claimed.keys().next();
      if (oldest.done === true) {
        break;
      }
      claimed.delete(oldest.value);
    }
  };

  return {
    claim: (key) => {
      const currentTime = now();
      expire(currentTime);
      if (claimed.has(key)) {
        return false;
      }
      claimed.set(key, currentTime);
      trimToCapacity();
      return true;
    },
    size: () => claimed.size,
  };
};
