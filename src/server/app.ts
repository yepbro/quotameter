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
 * `start` is called at most once per component instance, in registration
 * order; `stop` runs in reverse registration order. `stop` may be called
 * again after its own rejection: a rollback that follows a failed startup
 * records every component it could not release, and each `stop()` retry
 * re-calls exactly those until they release — so `stop` must tolerate being
 * re-entered after rejecting, releasing its resources on the retry.
 */
export interface LifecycleComponent {
  /** Stable identifier used in lifecycle events and diagnostics. */
  readonly name: string;
  /** Acquire resources. Throwing aborts startup and rolls back predecessors. */
  start(): Promise<void>;
  /**
   * Release resources. Throwing does not prevent other components from
   * stopping, and a rejected call stays addressable: the application may
   * call `stop` again to retry the release (see the interface contract).
   */
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

/** A component whose `stop` rejected, with the rejection reason. */
interface StopFailure {
  readonly component: LifecycleComponent;
  readonly error: unknown;
}

/** The uniform stop-failure report of both shutdown and the `'failed'` retry. */
function stopFailuresError(failures: readonly StopFailure[]): AggregateError {
  return new AggregateError(
    failures.map((failure) => failure.error),
    'one or more components failed to stop',
  );
}

/** Runs the startup and shutdown sequences of the assembled components. */
export class QuotameterApp {
  private readonly components: readonly LifecycleComponent[];
  private readonly onLifecycle?: (event: LifecycleEvent) => void;
  private currentState: AppState = 'created';
  private stopPromise: Promise<void> | undefined;
  /**
   * Components a startup rollback could not release, in reverse
   * registration order — non-empty whenever resources are still held:
   * while `'failed'` (where a non-empty record is exactly what makes
   * `stop()` retryable) and transiently during an in-flight retry round
   * (`'stopping'`, until the round's terminal state settles). Empty in
   * every settled released state.
   */
  private pendingCleanup: LifecycleComponent[] = [];

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
   * order, best-effort: a component whose rollback `stop` rejected may
   * still hold resources, so the app records it, the state becomes
   * `'failed'`, and the original error rethrows. A subsequent `stop()`
   * retries exactly the recorded components until they release, so startup
   * either fully succeeds or its leftovers stay addressable — never leaked
   * with no retry route.
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
      this.pendingCleanup = await this.rollback(started);
      this.setState('failed');
      throw error;
    }
    this.setState('running');
  }

  /**
   * Stops every component in reverse registration order.
   *
   * Safe to call repeatedly and concurrently (a second SIGTERM coalesces into
   * the in-flight shutdown). From `'created'` it is a no-op. From
   * `'running'` every component is stopped even when an earlier `stop`
   * fails; the collected failures then rethrow as an `AggregateError` with
   * the state left at `'stopped'`, and later calls return that settled
   * result (re-rejecting, so a later caller is not left unaware of the
   * failure). From `'starting'` it throws, because startup owns the
   * components until it settles.
   *
   * From `'failed'` — a startup whose rollback could not release every
   * component — it retries exactly the components whose rollback `stop`
   * rejected, in reverse registration order, never re-stopping the ones the
   * rollback (or an earlier retry) already released; a rollback that
   * released everything leaves it a no-op. A fully successful retry ends at
   * `'stopped'`; any failure rethrows as an `AggregateError` carrying this
   * round's errors, the still-unreleased components stay recorded, and the
   * state stays `'failed'` — so `stop` can be called again until every
   * resource is released.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.currentState === 'created' || this.currentState === 'stopped') {
      return;
    }
    if (this.currentState === 'starting') {
      throw new Error('cannot stop the application while it is starting');
    }
    if (this.currentState === 'failed') {
      if (this.pendingCleanup.length === 0) return;
      this.stopPromise = this.retryCleanup();
      return this.stopPromise;
    }
    this.stopPromise = this.shutdown();
    return this.stopPromise;
  }

  private async shutdown(): Promise<void> {
    this.setState('stopping');
    const failures = await this.stopComponents([...this.components].reverse());
    this.setState('stopped');
    if (failures.length > 0) throw stopFailuresError(failures);
  }

  /** Retries the components a startup rollback could not release. */
  private async retryCleanup(): Promise<void> {
    this.setState('stopping');
    const failures = await this.stopComponents([...this.pendingCleanup]);
    if (failures.length > 0) {
      // Resources are still held: record what remains and stay retryable —
      // the original startup error already propagated from `start`, and a
      // resolved stop here would claim a release that did not happen.
      this.pendingCleanup = failures.map((failure) => failure.component);
      this.setState('failed');
      this.stopPromise = undefined;
      throw stopFailuresError(failures);
    }
    // Kept for the documented invariant — nothing reads the field again
    // from `'stopped'`, but a settled stop holds no pending cleanup.
    this.pendingCleanup = [];
    this.setState('stopped');
  }

  /**
   * Stops the given components in the given order, releasing the rest even
   * when one rejects; returns each rejection with its component, so callers
   * decide between reporting (shutdown) and retrying (rollback).
   */
  private async stopComponents(components: readonly LifecycleComponent[]): Promise<StopFailure[]> {
    const failures: StopFailure[] = [];
    for (const component of components) {
      try {
        await component.stop();
      } catch (error) {
        failures.push({ component, error });
        continue;
      }
      this.emit({ type: 'component-stopped', component: component.name });
    }
    return failures;
  }

  /**
   * Stops the given already-started components in reverse order,
   * best-effort, and returns those whose stop rejected — the app records
   * them so `stop` can retry the release after the startup error has
   * propagated.
   */
  private async rollback(started: readonly LifecycleComponent[]): Promise<LifecycleComponent[]> {
    const failures = await this.stopComponents([...started].reverse());
    return failures.map((failure) => failure.component);
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
