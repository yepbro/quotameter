/**
 * Application lifecycle skeleton (task 060, spec §5.6).
 *
 * `QuotameterApp` owns the startup and shutdown sequences of the assembled
 * service components. It is deliberately free of process-level concerns —
 * signals, exit codes, and the runtime gate live in `main.ts` — so the
 * lifecycle itself stays testable with plain component stubs.
 *
 * Components are the plug-in point for the later construction tasks: the
 * single-instance lock (074) registers first, storage, the polling service,
 * and the HTTP listener (146) follow. Registration order is startup
 * dependency order; shutdown runs in reverse, which realizes the sequence
 * required by spec §5.6 by construction: stop scheduling new polls, wait for
 * in-flight work, close the database and checkpoint WAL, release the lock.
 * The full timing semantics (the 10-second in-flight wait) arrive with the
 * graceful-shutdown coordinator (075) inside its component's `stop`.
 */

/** Lifecycle states of the application. */
export type AppState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

/**
 * A service assembled into the application by the composition root.
 *
 * Both hooks are called at most once per component instance: `start` in
 * registration order, `stop` in reverse registration order.
 */
export interface LifecycleComponent {
  /** Stable identifier used in lifecycle events and diagnostics. */
  readonly name: string;
  /** Acquire resources. Throwing aborts startup and rolls back predecessors. */
  start(): Promise<void>;
  /** Release resources. Throwing does not prevent other components from stopping. */
  stop(): Promise<void>;
}

/** Emitted through {@link QuotameterAppOptions.onLifecycle} for diagnostics. */
export type LifecycleEvent =
  | { readonly type: 'state-change'; readonly state: AppState }
  | { readonly type: 'component-started'; readonly component: string }
  | { readonly type: 'component-stopped'; readonly component: string };

export interface QuotameterAppOptions {
  /** Components in startup dependency order; shut down in reverse order. */
  readonly components: readonly LifecycleComponent[];
  /**
   * Optional lifecycle sink for the structured logger (task 072). Callback
   * errors are swallowed: diagnostics must never take down the service. The
   * sink must be synchronous (its type says so) — a rejected promise it
   * returns would escape this guard.
   */
  readonly onLifecycle?: (event: LifecycleEvent) => void;
}

/** Runs the startup and shutdown sequences of the assembled components. */
export class QuotameterApp {
  private readonly components: readonly LifecycleComponent[];
  private readonly onLifecycle?: (event: LifecycleEvent) => void;
  private currentState: AppState = 'created';
  private stopPromise: Promise<void> | undefined;

  constructor(options: QuotameterAppOptions) {
    this.components = options.components;
    this.onLifecycle = options.onLifecycle;
  }

  /** Current lifecycle state. */
  get state(): AppState {
    return this.currentState;
  }

  /** True while the application is fully started and not yet shutting down. */
  get running(): boolean {
    return this.currentState === 'running';
  }

  /**
   * Starts every component in registration order.
   *
   * On failure, the components that did start are stopped again in reverse
   * order, the state becomes `'failed'`, and the original error rethrows —
   * startup either fully succeeds or leaves nothing running.
   */
  async start(): Promise<void> {
    if (this.currentState !== 'created') {
      throw new Error(`cannot start the application from state "${this.currentState}"`);
    }
    this.setState('starting');
    const started: LifecycleComponent[] = [];
    try {
      for (const component of this.components) {
        await component.start();
        started.push(component);
        this.emit({ type: 'component-started', component: component.name });
      }
    } catch (error) {
      await this.rollback(started);
      this.setState('failed');
      throw error;
    }
    this.setState('running');
  }

  /**
   * Stops every component in reverse registration order.
   *
   * Safe to call repeatedly and concurrently (a second SIGTERM coalesces into
   * the in-flight shutdown): from `'created'` or `'failed'` it is a no-op;
   * from `'stopped'` it returns the settled result of the first shutdown
   * (re-rejecting if that shutdown failed, so a later caller is not left
   * unaware of the failure). From `'starting'` it throws, because startup
   * owns the components until it settles. Every component is stopped even
   * when an earlier `stop` fails; the collected failures then rethrow as an
   * `AggregateError` with the state left at `'stopped'`.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (
      this.currentState === 'created' ||
      this.currentState === 'stopped' ||
      this.currentState === 'failed'
    ) {
      return;
    }
    if (this.currentState === 'starting') {
      throw new Error('cannot stop the application while it is starting');
    }
    this.stopPromise = this.shutdown();
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    this.setState('stopping');
    const failures: unknown[] = [];
    for (const component of [...this.components].reverse()) {
      try {
        await component.stop();
      } catch (error) {
        failures.push(error);
        continue;
      }
      this.emit({ type: 'component-stopped', component: component.name });
    }
    this.setState('stopped');
    if (failures.length > 0) {
      throw new AggregateError(failures, 'one or more components failed to stop');
    }
  }

  /** Stops the given already-started components in reverse order, best-effort. */
  private async rollback(started: readonly LifecycleComponent[]): Promise<void> {
    for (const component of [...started].reverse()) {
      try {
        await component.stop();
      } catch {
        // Rollback is already an error path: keep releasing the rest and let
        // the original startup error propagate to the caller.
        continue;
      }
      this.emit({ type: 'component-stopped', component: component.name });
    }
  }

  private setState(state: AppState): void {
    this.currentState = state;
    this.emit({ type: 'state-change', state });
  }

  private emit(event: LifecycleEvent): void {
    if (!this.onLifecycle) return;
    try {
      this.onLifecycle(event);
    } catch {
      // Diagnostics must never affect the lifecycle.
    }
  }
}
