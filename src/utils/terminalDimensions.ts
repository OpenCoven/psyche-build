export function getStreamDimension(
  stream: unknown,
  dimension: "columns" | "rows"
): number | undefined {
  if (typeof stream !== "object" || stream === null) {
    return undefined
  }

  const value = Reflect.get(stream, dimension)
  return typeof value === "number" ? value : undefined
}
