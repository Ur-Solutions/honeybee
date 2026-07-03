import assert from "node:assert/strict";
import { test } from "node:test";
import { mapWithConcurrency } from "../src/concurrency.js";

test("mapWithConcurrency preserves input order", async () => {
  const items = [5, 1, 4, 2, 3];
  const results = await mapWithConcurrency(items, 2, async (item, index) => {
    // Finish out of order: bigger items resolve later.
    await new Promise((resolve) => setTimeout(resolve, item * 5));
    return `${index}:${item * 10}`;
  });
  assert.deepEqual(results, ["0:50", "1:10", "2:40", "3:20", "4:30"]);
});

test("mapWithConcurrency never exceeds the cap", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  });
  assert.equal(peak, 3);
});

test("mapWithConcurrency handles empty input", async () => {
  const results = await mapWithConcurrency([], 4, async () => {
    throw new Error("worker must not run");
  });
  assert.deepEqual(results, []);
});

test("mapWithConcurrency clamps a nonsense cap to one worker", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3], 0, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return item * 2;
  });
  assert.deepEqual(results, [2, 4, 6]);
  assert.equal(peak, 1);
});

test("mapWithConcurrency rejects when a worker throws", async () => {
  await assert.rejects(
    mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error("boom");
      return item;
    }),
    /boom/,
  );
});
