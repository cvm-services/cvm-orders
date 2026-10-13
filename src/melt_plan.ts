/**
 * The melt plan: which legs of "pay with 2fiat" can run RIGHT NOW, and why the
 * others cannot (Phase C of PLAN-pay-with-2fiat).
 *
 * This module exists so the console never shows a dead button or a lying one.
 * It is pure over injected probes — no network in tests, real probes in prod.
 */

export interface PlanStep {
  id: "gate" | "melt" | "topup" | "card";
  label: string;
  ready: boolean;
  reason?: string;
}

export interface MeltPlan {
  steps: PlanStep[];
  /** True only when every leg is ready: the console may offer one-click. */
  executable: boolean;
}

/** What the mint probe reports. */
export interface MintProbe {
  reachable: boolean;
  nut05: boolean;
  error?: string;
}

/** Injected so tests never touch the network. */
export interface PlanDeps {
  probeMint: () => Promise<MintProbe>;
  topupReady?: () => Promise<{ ready: boolean; reason?: string }>;
}

/**
 * Build the plan for one order. The order shape is what the store returns
 * (settlement surfaced per ADR-0008, invoice cached, totals present).
 */
export async function meltPlan(order: unknown, deps: PlanDeps): Promise<MeltPlan> {
  const o = order as {
    payload?: { settlement?: { status?: string; proof?: { payment_hash?: string } } };
    total?: number;
    invoice?: unknown;
  };

  const steps: PlanStep[] = [];

  // (0) the sats gate — the same law the console enforces; never bypassed here
  const s = o?.payload?.settlement;
  const gateOk = s?.status === "settled" && Boolean(s?.proof?.payment_hash);
  steps.push({
    id: "gate",
    label: "customer sats settled",
    ready: gateOk,
    reason: gateOk ? undefined : "sats not proven — the sats gate (ADR-0008) is the law; fiat cannot move first",
  });

  // (1) melt — needs the gate AND a reachable mint that speaks NUT-05
  let meltOk = false;
  let meltReason: string | undefined;
  if (!gateOk) {
    meltReason = "waiting on the sats gate";
  } else if (!o?.invoice) {
    meltReason = "the order has no invoice to melt against";
  } else {
    const mint = await deps.probeMint();
    if (!mint.reachable) meltReason = `mint unreachable${mint.error ? ` (${mint.error})` : ""}`;
    else if (!mint.nut05) meltReason = "mint does not support NUT-05 melt";
    else meltOk = true;
  }
  steps.push({
    id: "melt",
    label: "melt sats out of the mint",
    ready: meltOk,
    reason: meltReason,
  });

  // (2) topup — needs 2fiat's edge reachable; today it is blocked, honestly
  let topupOk = false;
  let topupReason: string | undefined;
  if (deps.topupReady) {
    const t = await deps.topupReady();
    topupOk = t.ready;
    topupReason = t.reason;
  } else {
    topupReason = "2fiat top-up tool not deployed yet (Phase B)";
  }
  steps.push({ id: "topup", label: "top up the 2fiat wallet (BTC LN)", ready: topupOk, reason: topupReason });

  // (3) card — 3DS-gated upstream; the leg is a supervised hand-off, by design
  steps.push({
    id: "card",
    label: "2fiat card pays the venue",
    ready: topupOk,
    reason: topupOk
      ? "3DS challenge may appear in the 2fiat wallet; the console tracks the charge"
      : "waiting on the top-up leg",
  });

  return { steps, executable: steps.every((x) => x.ready) };
}
