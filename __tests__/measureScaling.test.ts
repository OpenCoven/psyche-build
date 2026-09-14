import { describe, expect, it } from 'vitest';
import { measureScaling } from './helpers/measureScaling';

describe('scaling measurement', () => {
  it('warms every size and interleaves a bounded five samples per size', () => {
    const calls: number[] = [];
    let time = 0;
    expect(measureScaling([1, 2], (size) => {
      calls.push(size);
      time += size;
    }, () => time)).toEqual([1, 2]);
    expect(calls).toEqual([2, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2]);
  });

  it('does not turn one preempted sample into a complexity regression', () => {
    const counts = new Map<number, number>();
    let time = 0;
    const durations = measureScaling([16, 32, 64, 128], (size) => {
      const count = (counts.get(size) ?? 0) + 1;
      counts.set(size, count);
      time += size + (size === 64 && count === 2 ? 10_000 : 0);
    }, () => time);
    expect(durations).toEqual([16, 32, 64, 128]);
  });

  it('does not bias the denominator toward a single unusually fast sample', () => {
    const counts = new Map<number, number>();
    let time = 0;
    const durations = measureScaling([16, 32, 64, 128], (size) => {
      const count = (counts.get(size) ?? 0) + 1;
      counts.set(size, count);
      time += size === 32 && count === 2 ? 1 : size;
    }, () => time);
    expect(durations).toEqual([16, 32, 64, 128]);
  });

  it('retains quadratic cost rather than hiding it with warmup or aggregation', () => {
    let time = 0;
    const durations = measureScaling([16, 32, 64, 128], (size) => {
      time += size * size;
    }, () => time);
    expect(durations).toEqual([256, 1024, 4096, 16384]);
    expect(durations[1]! / durations[0]!).toBe(4);
    const perCharacter = durations.map((duration, index) => duration / [16, 32, 64, 128][index]!);
    expect(Math.max(...perCharacter) / Math.min(...perCharacter)).toBe(8);
  });
});
