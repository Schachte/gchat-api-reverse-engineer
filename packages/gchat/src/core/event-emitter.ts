/**
 * Simple async event emitter for handling real-time events
 */
export type EventCallback = (...args: unknown[]) => void | Promise<void>;

export class EventEmitter {
  private _listeners: Map<string, Set<EventCallback>>;

  constructor() {
    this._listeners = new Map();
  }

  /**
   * Register an event listener
   * @param event - Event name
   * @param callback - Callback function (can be async)
   * @returns Unsubscribe function
   */
  on(event: string, callback: EventCallback): () => void {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => this.off(event, callback);
  }

  /**
   * Register a one-time event listener
   * @param event - Event name
   * @param callback - Callback function
   */
  once(event: string, callback: EventCallback): void {
    const onceWrapper = async (...args: unknown[]) => {
      this.off(event, onceWrapper);
      await callback(...args);
    };
    this.on(event, onceWrapper);
  }

  /**
   * Remove an event listener
   * @param event - Event name
   * @param callback - Callback function to remove
   */
  off(event: string, callback: EventCallback): void {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  /**
   * Emit an event to all listeners
   * @param event - Event name
   * @param args - Arguments to pass to listeners
   */
  async emit(event: string, ...args: unknown[]): Promise<void> {
    const listeners = this._listeners.get(event);
    if (listeners) {
      for (const callback of listeners) {
        try {
          await callback(...args);
        } catch (err) {
          console.error(`Error in event listener for "${event}":`, err);
        }
      }
    }
  }

  /**
   * Remove all listeners for an event (or all events if no event specified)
   * @param event - Event name
   */
  removeAllListeners(event?: string): void {
    if (event) {
      this._listeners.delete(event);
    } else {
      this._listeners.clear();
    }
  }
}
