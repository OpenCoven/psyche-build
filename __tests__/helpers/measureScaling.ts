export function measureScaling<T>(
  inputs: readonly T[],
  run: (input: T) => void,
  now: () => number = () => performance.now(),
): number[] {
  // Warm every size before sampling; a larger allocation must not be measured
  // for the first time only after all of the smaller samples have finished.
  for (const input of [...inputs].reverse()) {
    run(input);
  }

  const samples = inputs.map(() => [] as number[]);
  for (let round = 0; round < 5; round += 1) {
    // Alternate direction so host load and GC drift are not tied to input size.
    for (let offset = 0; offset < inputs.length; offset += 1) {
      const index = round % 2 === 0 ? offset : inputs.length - 1 - offset;
      const startedAt = now();
      run(inputs[index]!);
      samples[index]!.push(now() - startedAt);
    }
  }

  return samples.map((values) => values.sort((left, right) => left - right)[2]!);
}
