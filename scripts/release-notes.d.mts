export interface ReleaseNotes {
  github: string;
  testFlight: string;
}

export function readReleaseNotes(root: string, version: string): ReleaseNotes;
