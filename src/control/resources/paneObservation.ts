import { AGENT_CONTROL_LIMITS } from '../limits.js';
__OURS__
  readonly sequence: number;
  data: Buffer;
}

interface PaneOutputState {
__OURS__
}

export class PaneObservationStore {
  private readonly panes = new Map<string, PaneOutputState>();
__OURS__
}
