import {
  loadReputation,
  addDonated,
  addConsumed,
  getScore,
} from "./reputation.js";

export const POINTS_PER_TASK = 1;

export function getPointLedger(rep = loadReputation()) {
  const donated = rep.donated ?? 0;
  const consumed = rep.consumed ?? 0;

  return {
    donated,
    consumed,
    balance: donated - consumed,
    score: getScore(rep),
  };
}

export function formatPointLedger(rep = loadReputation()) {
  const ledger = getPointLedger(rep);
  const sign = ledger.balance >= 0 ? "+" : "";
  return `${sign}${ledger.balance} pts`;
}

export function spendTaskPoints(count = POINTS_PER_TASK) {
  return addConsumed(count);
}

export function earnTaskPoints(count = POINTS_PER_TASK) {
  return addDonated(count);
}
