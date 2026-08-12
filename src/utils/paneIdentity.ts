import { randomUUID } from 'node:crypto';

export function createPsychePaneId(): string {
  return `psyche-${randomUUID()}`;
}
