/** Minimal external store for React's useSyncExternalStore (no dependency). */
export class Store<S> {
  private listeners = new Set<() => void>();
  constructor(private state: S) {}
  get = (): S => this.state;
  set(patch: Partial<S> | ((s: S) => Partial<S>)) {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of [...this.listeners]) l();
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}
