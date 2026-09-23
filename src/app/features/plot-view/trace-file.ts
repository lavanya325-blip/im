import { PacketBus } from './models/plot-track.model';
import { EdgeCollection, TraceData } from './models/trace-data.model';

const EPS = 1e-12;
const MIN_EDGE = 1e-9;

const TRACK_ALIASES: Record<string, string> = {
  busa: 'busA',
  bus_a: 'busA',
  'bus a': 'busA',
  a: 'busA',
  channelindex_busa: 'busA',
  busb: 'busB',
  bus_b: 'busB',
  'bus b': 'busB',
  b: 'busB',
  channelindex_busb: 'busB',
  ch1: 'ch1',
  channel1: 'ch1',
  'channel 1': 'ch1',
  async1: 'ch1',
  ch2: 'ch2',
  channel2: 'ch2',
  'channel 2': 'ch2',
  async2: 'ch2',
  ch3: 'ch3',
  channel3: 'ch3',
  'channel 3': 'ch3',
  async3: 'ch3',
  ch4: 'ch4',
  channel4: 'ch4',
  'channel 4': 'ch4',
  async4: 'ch4'
};

/**
 * Turn the text of a loaded trace file into plot data.
 * Accepts the TraceData JSON shape, common aliases, or a CSV of sample levels.
 */
export function parseTraceText(text: string): TraceData {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Trace file is empty');
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return normalizeTrace(JSON.parse(trimmed) as unknown);
  }

  return parseLevelCsv(trimmed);
}

export function normalizeTrace(raw: unknown): TraceData {
  const source = unwrapTrace(raw);
  const channels = readChannels(source);
  const buses = readBuses(source);
  const edgeTimes = allEdgeTimes(channels);
  const packetTimes = allPacketTimes(buses);

  let startTime = readNumber(source, ['startTime', 'StartTime', 'referenceTime', 'ReferenceStartTime']);
  let endTime = readNumber(source, ['endTime', 'EndTime', 'stopTime', 'StopTime']);
  const referenceTime =
    readNumber(source, ['referenceTime', 'ReferenceStartTime', 'ReferenceTime']) ?? startTime ?? edgeTimes[0] ?? 0;

  if (startTime == null) {
    startTime = Math.min(...[...edgeTimes, ...packetTimes, referenceTime]);
  }
  if (endTime == null) {
    const last = Math.max(...[...edgeTimes, ...packetTimes, startTime]);
    endTime = last > startTime ? last : startTime + MIN_EDGE * 1000;
  }
  if (endTime < startTime) {
    endTime = startTime;
  }

  let minEdgeWidth = readNumber(source, ['minEdgeWidth', 'MinEdgeWidth']) ?? inferMinEdgeWidth(channels);
  if (!(minEdgeWidth > 0)) {
    minEdgeWidth = MIN_EDGE;
  }

  return {
    referenceTime,
    startTime,
    endTime,
    minEdgeWidth,
    channels,
    buses
  };
}

/** Map file channel names onto the lane ids the MIL template already renders. */
export function alignTraceToTracks(data: TraceData, trackIds: string[]): TraceData {
  const channels: Record<string, EdgeCollection> = {};
  const buses: Record<string, PacketBus[]> = {};
  const claimedChannels = new Set<string>();
  const claimedBuses = new Set<string>();

  const leftovers: EdgeCollection[] = [];
  Object.entries(data.channels).forEach(([id, collection]) => {
    const trackId = resolveTrackId(id, trackIds);
    if (trackId && !claimedChannels.has(trackId)) {
      claimedChannels.add(trackId);
      channels[trackId] = collection;
    } else {
      leftovers.push(collection);
    }
  });

  trackIds.forEach(trackId => {
    if (claimedChannels.has(trackId) || leftovers.length === 0) {
      return;
    }
    const next = leftovers.shift();
    if (next && next.edges.length > 0) {
      channels[trackId] = next;
      claimedChannels.add(trackId);
    }
  });

  const leftoverBuses: PacketBus[][] = [];
  Object.entries(data.buses).forEach(([id, packets]) => {
    const trackId = resolveTrackId(id, trackIds);
    if (trackId && !claimedBuses.has(trackId)) {
      claimedBuses.add(trackId);
      buses[trackId] = packets;
    } else {
      leftoverBuses.push(packets);
    }
  });

  trackIds.forEach(trackId => {
    if (claimedBuses.has(trackId) || leftoverBuses.length === 0) {
      return;
    }
    const next = leftoverBuses.shift();
    if (next && next.length > 0) {
      buses[trackId] = next;
    }
  });

  return { ...data, channels, buses };
}

export function traceHasSamples(data: TraceData, start: number, stop: number): boolean {
  const channelHit = Object.values(data.channels).some(collection =>
    collection.edges.some(time => time >= start - EPS && time <= stop + EPS)
  );
  if (channelHit) {
    return true;
  }
  return Object.values(data.buses).some(packets =>
    packets.some(packet => packet.EndTime >= start - EPS && packet.StartTime <= stop + EPS)
  );
}

function unwrapTrace(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    return { samples: raw };
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Trace file is not a JSON object');
  }

  const record = raw as Record<string, unknown>;
  for (const key of ['trace', 'data', 'capture', 'TraceData', 'plot']) {
    const nested = record[key];
    if (nested && typeof nested === 'object') {
      return nested as Record<string, unknown>;
    }
  }
  return record;
}

function readChannels(source: Record<string, unknown>): Record<string, EdgeCollection> {
  const channels: Record<string, EdgeCollection> = {};
  const bag = source['channels'] ?? source['Channels'] ?? source['waveforms'] ?? source['edges'];

  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    Object.entries(bag as Record<string, unknown>).forEach(([id, value]) => {
      const collection = toEdgeCollection(value);
      if (collection.edges.length > 0) {
        channels[id] = collection;
      }
    });
  }

  if (Object.keys(channels).length === 0 && Array.isArray(source['samples'])) {
    return channelsFromSamples(source['samples'] as unknown[]);
  }

  return channels;
}

function readBuses(source: Record<string, unknown>): Record<string, PacketBus[]> {
  const buses: Record<string, PacketBus[]> = {};
  const bag = source['buses'] ?? source['Buses'] ?? source['decode'] ?? source['packets'];
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) {
    return buses;
  }

  Object.entries(bag as Record<string, unknown>).forEach(([id, value]) => {
    if (!Array.isArray(value)) {
      return;
    }
    const packets = value
      .map(toPacket)
      .filter((packet): packet is PacketBus => packet != null)
      .sort((a, b) => a.StartTime - b.StartTime);
    if (packets.length > 0) {
      buses[id] = packets;
    }
  });
  return buses;
}

function toEdgeCollection(value: unknown): EdgeCollection {
  if (Array.isArray(value)) {
    return { firstEdgeRise: false, edges: numericList(value) };
  }
  if (!value || typeof value !== 'object') {
    return { firstEdgeRise: false, edges: [] };
  }

  const record = value as Record<string, unknown>;
  const edges = numericList(record['edges'] ?? record['Edges'] ?? record['times'] ?? []);
  const firstEdge = record['firstEdgeRise'] ?? record['FirstEdgeRise'] ?? record['firstEdge'];
  const firstEdgeRise =
    firstEdge === true || firstEdge === 'RISE' || firstEdge === 'rise' || firstEdge === 1;
  return { firstEdgeRise, edges };
}

function toPacket(value: unknown): PacketBus | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const start = readNumber(record, ['StartTime', 'startTime', 'start', 't0']);
  const end = readNumber(record, ['EndTime', 'endTime', 'end', 't1']);
  if (start == null || end == null) {
    return null;
  }
  const content = record['Content'] ?? record['content'] ?? record['text'] ?? record['label'] ?? '';
  return { StartTime: start, EndTime: end, Content: String(content) };
}

function channelsFromSamples(samples: unknown[]): Record<string, EdgeCollection> {
  const rows = samples
    .map(sample => (sample && typeof sample === 'object' ? (sample as Record<string, unknown>) : null))
    .filter((sample): sample is Record<string, unknown> => sample != null);

  const byChannel = new Map<string, { time: number; level: number }[]>();
  rows.forEach(row => {
    const time = readNumber(row, ['time', 'Time', 't', 'x']);
    const channel = String(row['channel'] ?? row['Channel'] ?? row['name'] ?? row['id'] ?? '');
    const level = readNumber(row, ['level', 'value', 'y', 'state']);
    if (time == null || level == null || !channel) {
      return;
    }
    const list = byChannel.get(channel) ?? [];
    list.push({ time, level });
    byChannel.set(channel, list);
  });

  const channels: Record<string, EdgeCollection> = {};
  byChannel.forEach((points, id) => {
    channels[id] = levelsToEdges(points);
  });
  return channels;
}

function parseLevelCsv(text: string): TraceData {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'));

  if (lines.length < 2) {
    throw new Error('Trace file has no samples');
  }

  const header = splitRow(lines[0]).map(cell => cell.trim());
  const timeIndex = header.findIndex(cell => /^(time|t|timestamp)$/i.test(cell));
  if (timeIndex < 0) {
    throw new Error('Trace CSV needs a time column');
  }

  const series = new Map<string, { time: number; level: number }[]>();
  header.forEach((name, index) => {
    if (index !== timeIndex && name) {
      series.set(name, []);
    }
  });

  for (let rowIndex = 1; rowIndex < lines.length; rowIndex++) {
    const cells = splitRow(lines[rowIndex]);
    const time = Number(cells[timeIndex]);
    if (!Number.isFinite(time)) {
      continue;
    }
    header.forEach((name, index) => {
      if (index === timeIndex || !name) {
        return;
      }
      const level = Number(cells[index]);
      if (Number.isFinite(level)) {
        series.get(name)?.push({ time, level });
      }
    });
  }

  const channels: Record<string, EdgeCollection> = {};
  series.forEach((points, name) => {
    if (points.length > 0) {
      channels[name] = levelsToEdges(points);
    }
  });

  return normalizeTrace({ channels });
}

function levelsToEdges(points: { time: number; level: number }[]): EdgeCollection {
  const ordered = [...points].sort((a, b) => a.time - b.time);
  const firstHigh = ordered[0].level >= 0.5;
  const edges: number[] = [ordered[0].time];
  let level = firstHigh;
  for (let index = 1; index < ordered.length; index++) {
    const nextHigh = ordered[index].level >= 0.5;
    if (nextHigh !== level) {
      edges.push(ordered[index].time);
      level = nextHigh;
    }
  }
  return { firstEdgeRise: firstHigh, edges };
}

function inferMinEdgeWidth(channels: Record<string, EdgeCollection>): number {
  let min = Number.POSITIVE_INFINITY;
  Object.values(channels).forEach(collection => {
    const edges = [...collection.edges].sort((a, b) => a - b);
    const limit = Math.min(edges.length, 1001);
    for (let index = 1; index < limit; index++) {
      const delta = edges[index] - edges[index - 1];
      if (delta > EPS && delta < min) {
        min = delta;
      }
    }
  });
  return Number.isFinite(min) ? min : MIN_EDGE;
}

function resolveTrackId(id: string, trackIds: string[]): string | null {
  if (trackIds.includes(id)) {
    return id;
  }
  const alias = TRACK_ALIASES[id.trim().toLowerCase()];
  if (alias && trackIds.includes(alias)) {
    return alias;
  }
  return null;
}

function numericList(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(item => Number(item)).filter(item => Number.isFinite(item));
}

function readNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function allEdgeTimes(channels: Record<string, EdgeCollection>): number[] {
  return Object.values(channels).flatMap(collection => collection.edges);
}

function allPacketTimes(buses: Record<string, PacketBus[]>): number[] {
  return Object.values(buses).flatMap(packets => packets.flatMap(packet => [packet.StartTime, packet.EndTime]));
}

function splitRow(line: string): string[] {
  return line.includes('\t') ? line.split('\t') : line.split(',');
}
