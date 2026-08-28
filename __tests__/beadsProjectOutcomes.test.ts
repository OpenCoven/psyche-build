import { expect, it } from 'vitest';

import {
  CANONICAL_OUTCOME_DIAGNOSTIC_ID_LIMIT,
} from '../scripts/beads-project-sync/outcomes.mjs';

const declaredDiagnosticLimit: 100 = CANONICAL_OUTCOME_DIAGNOSTIC_ID_LIMIT;

it('keeps the canonical outcome diagnostic limit declaration aligned with runtime', () => {
  expect(declaredDiagnosticLimit).toBe(100);
});
