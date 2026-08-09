/**
 * A value assigned exactly once, strictly after construction but before its first real use - the
 * pattern `index.ts`'s composition root already relies on for `commandDispatch`/`fleetConfirmFlow`
 * (two genuine two-way module dependencies: e.g. `inboundMedia` needs
 * `commandDispatch.dispatchInboundMessage` as an injected callback before `commandDispatch` itself
 * can be constructed, since building it needs `nlDispatch`, which in turn needs a forward reference
 * to `commandDispatch.dispatchFleetCommand`). That pattern was already safe in practice - every
 * reference lives inside a closure that only runs once a real Telegram event arrives, well after
 * the real assignment further down the same function - but the safety rested entirely on a doc
 * comment saying so, with nothing enforcing it. A future refactor that called the forward reference
 * too early would fail only with `Cannot read properties of undefined` deep inside some unrelated
 * method, not with a message naming what actually went wrong.
 *
 * `LateBound` makes both invariants explicit and checked at the point of failure: `set()` throws on
 * a second call (a forward-referenced value must be assigned exactly once), and `get()` throws if
 * nothing was ever assigned (read too early).
 */
export class LateBound<T> {
  private value: T | undefined;
  private assigned = false;

  set(value: T): void {
    if (this.assigned) throw new Error("LateBound.set() called twice - a forward-referenced value must be assigned exactly once");
    this.value = value;
    this.assigned = true;
  }

  get(): T {
    if (!this.assigned) throw new Error("LateBound.get() called before its value was ever set - a forward-referenced value was read too early");
    return this.value as T;
  }
}
