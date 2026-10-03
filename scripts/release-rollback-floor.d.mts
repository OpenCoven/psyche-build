export interface RollbackFloor {
  release: string;
  projectConfigSchemaVersion: number;
  reason: string;
}

export const ROLLBACK_FLOOR_FILE: string;
export const SCHEMA_SOURCE_FILE: string;
export const ROLLBACK_FLOOR_PROCEDURE: string;
export function readRollbackFloor(root?: string): RollbackFloor;
export function readProjectConfigSchemaVersion(root?: string): number;
export function assertRollbackFloor(root?: string): { release: string; schemaVersion: number };
