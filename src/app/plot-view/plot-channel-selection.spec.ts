import { describe, expect, it } from 'vitest';
import { applyBusChannelSelection, PlotMapEntry } from './plot-channel-selection';
import { BUS_CHANNEL_COLORS } from '../shared/models/channel-selection.model';

function makeCtx(plotMap: Map<string, PlotMapEntry>) {
  return {
    plotMap,
    busMap: new Map<string, unknown[]>(),
    busPolygons: new Map<string, unknown>(),
    channelPaths: new Map<string, unknown>(),
    channelColors: new Map<string, string>(),
    lanes: [],
    seedSeriesFromPlotMap: () => undefined,
    resizePlot: () => undefined,
    edgeAvailableResponse: undefined
  };
}

describe('applyBusChannelSelection', () => {
  it('defaults to CH1 when no channels are checked', () => {
    const plotMap = new Map<string, PlotMapEntry>();
    const ctx = makeCtx(plotMap);

    applyBusChannelSelection(ctx, {
      source: 'Bus A',
      sampleRate: 125,
      channels: []
    });

    expect(plotMap.get('CH1')?.selected).toBe(true);
    expect(ctx.lanes).toHaveLength(1);
    expect(ctx.lanes[0].id).toBe('CH1');
    expect(ctx.channelColors.get('CH1')).toBe(BUS_CHANNEL_COLORS.CH1);
  });

  it('shows all selected channels with their colors', () => {
    const plotMap = new Map<string, PlotMapEntry>([
      ['CH1', { name: 'CH1', channel: 1, allowSelection: true, selected: true, subtitle: 'Async' }],
      ['CH2', { name: 'CH2', channel: 2, allowSelection: true, selected: true, subtitle: 'Async' }]
    ]);
    const ctx = makeCtx(plotMap);

    applyBusChannelSelection(ctx, {
      source: 'Bus A',
      sampleRate: 125,
      channels: [
        { id: 'CH1', name: 'Alpha', checked: true, color: BUS_CHANNEL_COLORS.CH1 },
        { id: 'CH2', name: 'Beta', checked: true, color: BUS_CHANNEL_COLORS.CH2 }
      ]
    });

    expect(plotMap.get('CH1')?.name).toBe('Alpha');
    expect(plotMap.get('CH2')?.selected).toBe(true);
    expect(ctx.lanes).toHaveLength(2);
    expect(ctx.channelColors.get('CH2')).toBe(BUS_CHANNEL_COLORS.CH2);
  });

  it('removes MIL protocol decode rows', () => {
    const plotMap = new Map<string, PlotMapEntry>([
      ['BUS0', { name: 'MIL__1', allowSelection: false, selected: true, subtitle: 'MIL 1553', protocolName: 'MIL__1' }],
      ['CH1', { name: 'CH1', channel: 1, allowSelection: true, selected: true, subtitle: 'Async' }]
    ]);
    const ctx = makeCtx(plotMap);

    applyBusChannelSelection(ctx, {
      source: 'Bus A',
      sampleRate: 125,
      channels: [{ id: 'CH1', name: 'CH1', checked: true, color: BUS_CHANNEL_COLORS.CH1 }]
    });

    expect(plotMap.has('BUS0')).toBe(false);
  });
});
