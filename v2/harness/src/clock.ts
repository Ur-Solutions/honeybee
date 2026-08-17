/**
 * Virtual clock — the only time source in the harness. One tick = one sim step
 * = one virtual millisecond. No wall time anywhere: the CoreStore, the driver,
 * the daemon and the invariant bounds all read this clock.
 */
export class SimClock {
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  /** Bound method so it can be handed to CoreStore as its `now` option. */
  now = (): number => this.t;

  advance(ms = 1): void {
    this.t += ms;
  }
}
