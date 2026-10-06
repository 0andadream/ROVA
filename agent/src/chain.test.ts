import assert from "node:assert/strict";
import test from "node:test";
import { logRanges } from "./chain.ts";

test("log ranges stay inside the 100-block public RPC limit and do not skip blocks", () => {
  assert.deepEqual(logRanges(10n, 9n), []);
  assert.deepEqual(logRanges(5n, 5n), [[5n, 5n]]);
  assert.deepEqual(logRanges(0n, 100n), [[0n, 100n]]);
  assert.deepEqual(logRanges(0n, 101n), [
    [0n, 100n],
    [101n, 101n],
  ]);
  assert.deepEqual(logRanges(0n, 302n), [
    [0n, 100n],
    [101n, 201n],
    [202n, 302n],
  ]);
  const ranges = logRanges(1_000n, 1_250n);
  for (const [from, to] of ranges) assert.ok(to - from <= 100n);
  assert.equal(ranges[0][0], 1_000n);
  assert.equal(ranges.at(-1)?.[1], 1_250n);
  for (let index = 1; index < ranges.length; index += 1) {
    assert.equal(ranges[index][0], ranges[index - 1][1] + 1n);
  }
});
