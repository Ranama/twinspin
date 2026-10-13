// Tiny event emitter used by every stateful module (engine, decks, sync, outputs, settings, remote).
//   const off = thing.on('change', (what) => ...);  off();
//   thing.once('ready', fn);  thing.emit('change', 'tempo');
// Listener errors are caught and logged so one broken UI binding cannot stop the audio code that emitted.

export class Emitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /** Subscribe. Returns an unsubscribe function. */
  on(type, fn) {
    let set = this._listeners.get(type);
    if (!set) this._listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const set = this._listeners.get(type);
    if (set) set.delete(fn);
  }

  once(type, fn) {
    const off = this.on(type, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  emit(type, ...args) {
    const set = this._listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[TwinSpin] listener for "${type}" failed`, err);
      }
    }
  }
}
