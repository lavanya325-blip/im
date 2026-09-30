import assert from 'node:assert/strict';
import {
  edgeTimes,
  entriesFromEdges,
  initialVisibleWindow,
  isWaveformChannel,
  mergeEdgeChannels,
  viewFromEdgeSample,
  waveformEntries
} from './plot-edge-pipeline.ts';

assert.equal(isWaveformChannel(0), true);
assert.equal(isWaveformChannel(undefined), false);
assert.equal(isWaveformChannel(null), false);

const fromFile = entriesFromEdges([
  { Channel: 0, Count: 10 },
  { Channel: 2, Count: 4 }
]);
assert.deepEqual(
  fromFile.map(entry => entry.channel),
  [0, 2]
);
assert.equal(waveformEntries(fromFile).length, 2);

const configured = [
  { key: 'SCL', name: 'SCL', channel: 0, selected: true },
  { key: 'BUS', name: 'BUS', selected: true }
];
assert.equal(waveformEntries(configured).map(entry => entry.key).join(','), 'SCL');

const merged = mergeEdgeChannels(configured, [
  { Channel: 0, Count: 8 },
  { Channel: 3, Count: 8 }
]);
assert.deepEqual(
  waveformEntries(merged).map(entry => entry.channel),
  [0, 3]
);

assert.deepEqual(edgeTimes([1, 2, { Time: 4 }, { time: 5 }, null, 'x']), [1, 2, 4, 5]);

const [start, stop] = initialVisibleWindow(10, 0);
assert.equal(start, 10);
assert.ok(stop > start);

const [nanStart, nanStop] = initialVisibleWindow(1.5, Number.NaN);
assert.ok(Number.isFinite(nanStop - nanStart) && nanStop > nanStart);

const base = 1942239.582251;
const sample = [];
for (let i = 0; i < 80; i++) {
  sample.push(base + i * 1e-6);
}
sample.splice(1, 0, base + 1e-15);
const view = viewFromEdgeSample(sample, base, base + 10, 1000);
assert.ok(view.stop - view.start > 70e-6, 'window follows the edge span, not the glitch');
assert.ok(view.minEdgeWidth > 1e-7, 'min edge width ignores the tiny gap');
assert.ok(view.start >= base - 1e-9);

console.log('plot-edge-pipeline tests passed');
