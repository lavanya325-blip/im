import {
  Channel,
  ChannelSelection,
  channelIdToNumber,
  defaultChannelWhenEmpty
} from '../shared/models/channel-selection.model';
import { PlotTrack } from '../shared/models/channel-selection.model';

export type PlotMapEntry = {
  name: string;
  channel?: number;
  allowSelection: boolean;
  selected: boolean;
  subtitle: string;
  protocolName?: string;
};

export interface PlotChannelSelectionContext {
  plotMap: Map<string, PlotMapEntry>;
  busMap: Map<string, unknown[]>;
  busPolygons: Map<string, unknown>;
  channelPaths: Map<string, unknown>;
  channelColors: Map<string, string>;
  lanes: PlotTrack[];
  seedSeriesFromPlotMap(): void;
  resizePlot(): void;
  edgeAvailableResponse?: { ChannelEdgeAvailable: unknown[] };
}

/** Removes MIL protocol decode rows (e.g. MIL__1 / BUS* entries) from the plot. */
export function removeMilDecodeLanes(ctx: PlotChannelSelectionContext): void {
  for (const [key, entry] of [...ctx.plotMap.entries()]) {
    if (entry.channel == null && entry.protocolName) {
      ctx.plotMap.delete(key);
      ctx.busMap.delete(key);
      ctx.busPolygons.delete(key);
    }
  }
}

export function applyBusChannelSelection(
  ctx: PlotChannelSelectionContext,
  selection: ChannelSelection
): void {
  const active = defaultChannelWhenEmpty(selection.channels);
  const activeIds = new Set(active.map(c => c.id.toUpperCase()));
  const activeNums = new Set(
    active.map(c => channelIdToNumber(c.id)).filter(n => Number.isFinite(n) && n > 0)
  );

  removeMilDecodeLanes(ctx);

  for (const ch of active) {
    const num = channelIdToNumber(ch.id);
    if (!Number.isFinite(num) || num <= 0) {
      continue;
    }
    const key = 'CH' + num;
    const existing = ctx.plotMap.get(key);
    if (existing) {
      existing.name = ch.name;
      existing.selected = true;
      existing.subtitle = 'Async';
    } else {
      ctx.plotMap.set(key, {
        name: ch.name,
        channel: num,
        allowSelection: true,
        selected: true,
        subtitle: 'Async'
      });
    }
    ctx.channelColors.set(key, ch.color);
    ctx.channelColors.set(ch.id.toUpperCase(), ch.color);
  }

  ctx.plotMap.forEach((entry, key) => {
    if (entry.channel == null) {
      return;
    }
    const num = entry.channel as unknown as number;
    const idKey = 'CH' + num;
    const included =
      activeNums.has(num) ||
      activeIds.has(idKey) ||
      activeIds.has(key.toUpperCase());
    entry.selected = included;
    if (!included) {
      ctx.channelPaths.delete(key);
    }
  });

  ctx.lanes = buildLanesFromChannels(active, ctx.channelColors);
  ctx.seedSeriesFromPlotMap();

  if (ctx.edgeAvailableResponse) {
    ctx.resizePlot();
  }
}

function buildLanesFromChannels(
  channels: Channel[],
  colors: Map<string, string>
): PlotTrack[] {
  return channels.map(ch => {
    const id = ch.id.toUpperCase();
    const key = id.startsWith('CH') ? id : `CH${channelIdToNumber(id)}`;
    return {
      id: key,
      name: ch.name,
      subtitle: 'Async',
      color: colors.get(key) ?? ch.color,
      kind: 'channel' as const
    };
  });
}
