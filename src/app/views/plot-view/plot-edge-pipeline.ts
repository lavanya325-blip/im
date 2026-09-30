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
