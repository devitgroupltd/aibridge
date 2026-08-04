import type { Model } from "./session-commands.ts";
import type { SessionRow } from "./session-store.ts";

/**
 * §10.5 point 1's weighted concurrency budget. Opus costs twice a Sonnet session, Haiku half - one
 * line of arithmetic in place of a flat session-count cap that would either under-use a Sonnet-only
 * day or over-commit the plan the moment two sessions upgraded. Fable isn't in the plan's own table
 * (written before `/new --fable` existed) - weighted the same as Haiku here as the reasonable default
 * for a model in the same "cheap/fast" tier, not a verified figure.
 */
export const MODEL_WEIGHT: Record<Model, number> = {
  sonnet: 1,
  opus: 2,
  haiku: 0.5,
  fable: 0.5,
};

export const WEIGHTED_CAP = 4;

function weightOf(model: string): number {
  return MODEL_WEIGHT[model as Model] ?? 1;
}

/** Sum of every non-`dead` row's model weight - a killed-but-not-removed row no longer counts
 * against the budget, matching `/rm`'s own "dead rows are inert" convention elsewhere. */
export function currentUnits(rows: readonly SessionRow[]): number {
  return rows.filter((r) => r.state !== "dead").reduce((sum, r) => sum + weightOf(r.model), 0);
}

export type CapCheck = { ok: true } | { ok: false; current: number; wouldBe: number };

/** Whether adding one more session of `model` would push the fleet over `WEIGHTED_CAP`. Returns the
 * current and prospective totals so the refusal message can show the caller their live allocation
 * (§10.5: "`/new` refuses over-budget with the current allocation in the refusal"). */
export function checkConcurrencyCap(rows: readonly SessionRow[], model: string): CapCheck {
  const current = currentUnits(rows);
  const wouldBe = current + weightOf(model);
  if (wouldBe > WEIGHTED_CAP) return { ok: false, current, wouldBe };
  return { ok: true };
}
