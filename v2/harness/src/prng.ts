/**
 * Seeded PRNG (mulberry32) — the single randomness source of a simulation run.
 * Every run is fully determined by (seed, config): all components draw from one
 * shared stream in a deterministic order, which is what makes failures
 * replayable from the seed printed in the violation ledger.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** True with probability p. p <= 0 never draws (keeps disabled features free). */
  chance(p: number): boolean {
    if (p <= 0) return false;
    return this.next() < p;
  }

  /** Uniform integer in [minInclusive, maxInclusive]. */
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(xs: readonly T[]): T | undefined {
    if (xs.length === 0) return undefined;
    return xs[Math.floor(this.next() * xs.length)];
  }
}
