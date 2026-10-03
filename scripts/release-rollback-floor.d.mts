export type PinnedFormatName =
  | 'PROJECT_CONFIG_SCHEMA_VERSION'
  | 'RECOVERY_MARKER_VERSION'
  | 'PANE_SLUG_RECORD_VERSION'
  | 'PSYCHE_TMUX_CONFIG_VERSION'
  | 'RITUAL_VERSION'
  | 'PANE_LAYOUT_VERSION';

export interface RollbackFloor {
  release: string;
  reason: string;
  persistedFormatVersions: Record<PinnedFormatName, number>;
}

export const ROLLBACK_FLOOR_FILE: string;
export const ROLLBACK_FLOOR_PROCEDURE: string;
export const PINNED_FORMATS: Readonly<Record<PinnedFormatName, string>>;
export function readRollbackFloor(root?: string): RollbackFloor;
export function readPinnedFormatVersion(root: string, name: PinnedFormatName): number;
export function assertRollbackFloor(root?: string): {
  release: string;
  versions: Record<PinnedFormatName, number>;
};
