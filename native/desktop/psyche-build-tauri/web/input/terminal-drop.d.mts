export interface ImageDropInsertion {
  accepted: string[];
  skipped: string[];
  text: string;
}

export interface Point {
  x: number;
  y: number;
}

export function isSupportedImagePath(path: unknown): boolean;
export function quotePosixPath(path: string): string;
export function buildImageDropInsertion(paths: unknown): ImageDropInsertion;
export function physicalToCssPosition(
  position: Partial<Point> | null | undefined,
  scaleFactor: number,
): Point | null;
