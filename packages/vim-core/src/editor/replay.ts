export interface ReplayBudget {
  actions: number;
}

export function consumeReplayAction(budget: ReplayBudget, limit: number): boolean {
  budget.actions += 1;
  return budget.actions <= limit;
}
