/**
 * The order service's own reconciler (G1).
 *
 * Measured live 2026-10-11: the only thing that ever asked the mint "was this
 * invoice paid?" was the CUSTOMER's browser (`GET /orders/:id`, every 5s while
 * the pay screen was open). Pay and close the tab — or background the tab while
 * switching to a wallet app — and the order stayed `awaiting_payment` forever:
 * a settled invoice that nobody ever read, money stranded with no state change.
 * Invoice expiry rode the same poll, so nothing expired either.
 *
 * This module is the service's answer to that: a periodic reconciler over
 * `(order, invoice)` that runs with no HTTP client attached. It is deliberately
 * dumb about authority — it holds none:
 *
 *   * `paid` is only ever written from a rail verdict of `settled`. The sweep is
 *     another caller of the rail, not another source of truth (ADR-0008). A
 *     client body, a credential, an operator and this sweep all go through the
 *     same gate.
 *   * `expired` comes from the rail saying so, or from the clock passing the
 *     invoice's own `expiresAt` while the rail says the quote is still pending.
 *   * A rail that throws or cannot be resolved is NOT a verdict: the tick logs
 *     one line and changes nothing (fail-closed). A mint blip must never expire
 *     — or pay — an order.
 *   * A settled verdict outranks a stale local expiry: if the invoice looks dead
 *     by our clock but the mint says the sats arrived, it is paid. Money first,
 *     then the clock.
 *
 * Everything the reconciler needs is injected — the store, the rail, the clock,
 * the log sink — so a test drives it deterministically and the service has no
 * test-only branch (`NODE_ENV` is never read here).
 */
import type { Order, OrderState, TransitionMeta } from "./store.ts";
import type { PaymentRail, SettlementStatus } from "./rail.ts";

/** Enabled by default at 30s; `ORDER_SWEEP_INTERVAL_MS=0` disables it. */
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/** The slice of the order store a sweep needs (so a test can count transitions). */
export interface SweeperStore {
  all(): Order[];
  get(id: string): Order | undefined;
  transition(id: string, to: OrderState, meta?: TransitionMeta): Order;
}

export interface SweeperDeps {
  store: SweeperStore;
  /**
   * The rail, or a (possibly async) resolver for it — the service resolves its
   * mint lazily and must not do that work at import time. `null` means "no rail
   * configured", which is not a settlement verdict either.
   */
  rail: PaymentRail | null | (() => PaymentRail | null | Promise<PaymentRail | null>);
  /**
   * Epoch MILLISECONDS. Injected so expiry is testable without sleeping, and so
   * a deployment can pin its own clock.
   */
  now?: () => number;
  /** One line per event. Defaults to `console.log`. */
  log?: (line: string) => void;
}

/** What one tick did. Counts, not prose, so a caller can assert or export them. */
export interface SweepReport {
  /** Orders asked about (awaiting_payment, with an invoice). */
  checked: number;
  paid: number;
  expired: number;
  /** Rail answered, but there was nothing to do. */
  unchanged: number;
  /** Rail could not answer; left exactly as they were. */
  unavailable: number;
}

export interface SweeperOptions {
  /** Milliseconds between ticks. `0` (or a non-finite value) disables the sweep. */
  intervalMs?: number;
  /** Overrides `deps.now`. */
  now?: () => number;
}

export interface SweeperHandle {
  readonly intervalMs: number;
  /** false when the sweep was configured off — a caller can log that fact. */
  readonly active: boolean;
  stop(): void;
}

const consoleLog = (line: string) => console.log(line);

async function resolveRail(deps: SweeperDeps): Promise<PaymentRail | null> {
  if (typeof deps.rail === "function") return await deps.rail();
  return deps.rail ?? null;
}

/** `expiresAt` is ISO-8601; an unparseable one never expires anything. */
function isPast(expiresAt: string, nowMs: number): boolean {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) && nowMs > at;
}

/**
 * Apply a verdict through the store's compare-and-set. Returns false when a
 * concurrent customer poll (or another tick) already moved the order: that is
 * the "exactly once" mechanism, not an error, and nothing is reported.
 */
function commit(store: SweeperStore, id: string, to: OrderState, log: (line: string) => void): boolean {
  try {
    store.transition(id, to, { from: "awaiting_payment" });
  } catch {
    return false;
  }
  log(`orders sweep: ${id} awaiting_payment -> ${to} (rail verdict)`);
  return true;
}

/**
 * One pass over every `awaiting_payment` order that has an invoice.
 *
 * Never rejects: a broken rail, a broken store or a store that throws leaves the
 * state untouched, because the alternative — guessing — is how money goes
 * missing. Orders in any other state are never even looked at.
 */
export async function sweepOnce(deps: SweeperDeps): Promise<SweepReport> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? consoleLog;
  const report: SweepReport = { checked: 0, paid: 0, expired: 0, unchanged: 0, unavailable: 0 };

  let candidates: Order[];
  try {
    candidates = deps.store.all().filter((o) => o.state === "awaiting_payment" && o.invoice !== undefined);
  } catch {
    log("orders sweep: order store unreadable this tick; no state change");
    return report;
  }
  if (candidates.length === 0) return report;

  let rail: PaymentRail | null;
  try {
    rail = await resolveRail(deps);
  } catch {
    rail = null;
  }
  if (!rail) {
    log(`orders sweep: no payment rail available; ${candidates.length} awaiting_payment order(s) left alone (fail-closed)`);
    return report;
  }

  for (const order of candidates) {
    const invoice = order.invoice;
    if (!invoice) continue;
    report.checked++;

    let verdict: SettlementStatus;
    try {
      verdict = await rail.checkSettlement(invoice.quoteId);
    } catch {
      // Fail closed. No verdict, no state change — even if our own clock says the
      // invoice is stale, only the mint may declare it dead.
      report.unavailable++;
      continue;
    }

    if (verdict === "settled") {
      if (commit(deps.store, order.id, "paid", log)) report.paid++;
      else report.unchanged++;
      continue;
    }
    if (verdict === "expired" || isPast(invoice.expiresAt, now())) {
      if (commit(deps.store, order.id, "expired", log)) report.expired++;
      else report.unchanged++;
      continue;
    }
    report.unchanged++;
  }

  // One line per failure class per tick: a mint outage must not flood the log
  // (nor hide the orders it is holding up).
  if (report.unavailable > 0) {
    log(`orders sweep: rail unreachable for ${report.unavailable} of ${report.checked} order(s); no state change (fail-closed)`);
  }
  return report;
}

/**
 * Start the periodic sweep. The returned handle owns the timer; `stop()` clears
 * it. A tick that is still running when the next one is due is skipped rather
 * than queued, so a slow mint cannot stack sweeps on top of itself.
 */
export function startSweeper(deps: SweeperDeps, options: SweeperOptions = {}): SweeperHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const log = deps.log ?? consoleLog;
  const tickDeps: SweeperDeps = options.now ? { ...deps, now: options.now } : deps;

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { intervalMs, active: false, stop() {} };
  }

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await sweepOnce(tickDeps);
    } catch (e) {
      // sweepOnce already contains every failure it knows about; this is the
      // last line of defence so the timer — the service's liveness — survives.
      try {
        log(`orders sweep: tick failed (${e instanceof Error ? e.name : "error"}); the service keeps running`);
      } catch {
        // A log sink that throws is not worth the service's life either.
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  return {
    intervalMs,
    active: true,
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * `ORDER_SWEEP_INTERVAL_MS`: 30000 by default, `0` disables the sweep (tests and
 * an operator-controlled opt-out rely on that), and anything unparseable or
 * negative falls back to the default — a typo in the environment must never be
 * read as "stop checking whether customers paid".
 */
export function sweepIntervalMsFromEnv(
  env: { get(key: string): string | undefined },
  fallback = DEFAULT_SWEEP_INTERVAL_MS,
): number {
  const raw = env.get("ORDER_SWEEP_INTERVAL_MS");
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  if (parsed === 0) return 0;
  return Math.floor(parsed);
}
