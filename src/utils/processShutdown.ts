interface PsycheProcessShutdownState {
  claimed: boolean;
  owner?: string;
}

type GlobalWithPsycheShutdownState = typeof globalThis & {
  __psycheProcessShutdownState?: PsycheProcessShutdownState;
};

function getShutdownState(): PsycheProcessShutdownState {
  const globalWithState = globalThis as GlobalWithPsycheShutdownState;
  if (!globalWithState.__psycheProcessShutdownState) {
    globalWithState.__psycheProcessShutdownState = {
      claimed: false,
    };
  }

  return globalWithState.__psycheProcessShutdownState;
}

export function claimProcessShutdown(owner: string): boolean {
  const state = getShutdownState();
  if (state.claimed) {
    return false;
  }

  state.claimed = true;
  state.owner = owner;
  return true;
}

export function getClaimedProcessShutdownOwner(): string | undefined {
  return getShutdownState().owner;
}

export function resetProcessShutdownForTesting(): void {
  const state = getShutdownState();
  state.claimed = false;
  state.owner = undefined;
}
