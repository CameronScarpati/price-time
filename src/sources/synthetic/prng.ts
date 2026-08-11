/**
 * mulberry32: a small, fast, seedable PRNG. Statistical quality is far beyond
 * what agent behavior needs, and a 32-bit seed keeps runs trivially shareable.
 * The engine itself never draws randomness — only agents do.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Exponential inter-arrival with the given rate (events per unit time). */
  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Log-normal-ish positive draw around `median` with heavy right tail. */
  size(median: number, spread = 1): number {
    const gaussian =
      Math.sqrt(-2 * Math.log(1 - this.next())) * Math.cos(2 * Math.PI * this.next());
    return Math.max(1, Math.round(median * Math.exp(spread * gaussian)));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}
