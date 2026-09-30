/**
 * Pure helpers for turning an uploaded edge list into drawable series.
 * Kept separate so the DAT-upload path can be checked without Angular.
 */

export type PlotEntryLike = {
  key: string;
  name: string;
  channel?: number | null;
  selected: boolean;
};

export type EdgeChannelLike = {
  Channel: number;
  Count?: number;
};

const DEFAULT_MIN_EDGE_WIDTH = 50e-9;

/** Channel 0 is a real waveform. A truthy check drops it and the lane stays empty. */
export function isWaveformChannel(channel: number | null | undefined): channel is number {
  return channel !== undefined && channel !== null && Number.isFinite(channel);
}

export function edgeTimes(edges: unknown): number[] {
  if (!Array.isArray(edges)) {
    return [];
  }
  const times: number[] = [];
  for (const edge of edges) {
    if (typeof edge === 'number' && Number.isFinite(edge)) {
      times.push(edge);
      continue;
    }
    if (edge && typeof edge === 'object') {
      const record = edge as { Time?: unknown; time?: unknown; x?: unknown };
      const time = record.Time ?? record.time ?? record.x;
      if (typeof time === 'number' && Number.isFinite(time)) {
        times.push(time);
      }
    }
  }
  return times;
}

export function positiveEdgeWidth(width: number | null | undefined): number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : DEFAULT_MIN_EDGE_WIDTH;
}

/** First view is a window of ~1000 minimum edges, and it must be a finite non-zero span. */
export function initialVisibleWindow(dataStart: number, minEdgeWidth: number | null | undefined): [number, number] {
  const start = Number.isFinite(dataStart) ? dataStart : 0;
  return [start, start + positiveEdgeWidth(minEdgeWidth) * 1000];
}

export type EdgeView = {
  start: number;
  stop: number;
  minEdgeWidth: number;
};

/**
 * Open the plot on the span of the first edges, not on the smallest delta.
 * A single glitch (or a float-sized gap) used as minEdgeWidth * 1000 collapses
 * the axis so every label is the same time and the trace looks like a flat line.
 */
export function viewFromEdgeSample(times: number[], dataStart: number, dataEnd: number, edgesToShow = 1000): EdgeView {
  const sorted = times.filter((time): time is number => Number.isFinite(time)).sort((a, b) => a - b);
  const origin = Number.isFinite(dataStart) ? dataStart : (sorted[0] ?? 0);
  const domainEnd = Number.isFinite(dataEnd) && dataEnd > origin ? dataEnd : undefined;
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const delta = sorted[i] - sorted[i - 1];
    if (delta > 0) {
      deltas.push(delta);
    }
  }
  deltas.sort((a, b) => a - b);
  const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : DEFAULT_MIN_EDGE_WIDTH;
  const typical = positiveEdgeWidth(deltas.find(delta => delta >= median * 0.05) ?? median);
  const count = Math.max(1, edgesToShow);

  let start = sorted.length ? sorted[0] : origin;
  const lastIndex = Math.min(sorted.length - 1, count);
  let stop = sorted.length > 1 ? sorted[lastIndex] : start + typical * count;
  if (!(stop > start)) {
    stop = start + typical * count;
  }
  const pad = Math.max((stop - start) * 0.02, typical);
  start -= pad;
  stop += pad;
  if (start < origin) {
    start = origin;
  }
  if (domainEnd != null && stop > domainEnd) {
    stop = domainEnd;
  }
  if (!(stop > start)) {
    stop = start + typical * 40;
  }
  return { start, stop, minEdgeWidth: typical };
}

/**
 * Edges often arrive before InitializeRun fills the plot map.
 * Seed one selected waveform row per channel in the file, including channel 0.
 */
export function entriesFromEdges(channels: EdgeChannelLike[]): PlotEntryLike[] {
  return channels
    .filter(channel => isWaveformChannel(channel.Channel))
    .map((channel, index) => ({
      key: 'CH' + channel.Channel,
      name: 'Channel ' + (index + 1),
      channel: channel.Channel,
      selected: true
    }));
}

/** Add file channels that configuration never listed, without duplicating existing ones. */
export function mergeEdgeChannels(entries: PlotEntryLike[], channels: EdgeChannelLike[]): PlotEntryLike[] {
  const merged = entries.map(entry => ({ ...entry }));
  for (const channel of channels) {
    if (!isWaveformChannel(channel.Channel)) {
      continue;
    }
    if (merged.some(entry => entry.channel === channel.Channel)) {
      continue;
    }
    merged.push({
      key: 'CH' + channel.Channel,
      name: 'Channel ' + channel.Channel,
      channel: channel.Channel,
      selected: true
    });
  }
  return merged;
}

export function waveformEntries(entries: PlotEntryLike[]): PlotEntryLike[] {
  return entries.filter(entry => entry.selected && isWaveformChannel(entry.channel));
}
