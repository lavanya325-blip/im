import { DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ChannelPlotBridgeService } from './services/channel-plot-bridge.service';
import {
  PlotChannelSelectionContext,
  applyBusChannelSelection
} from './plot-channel-selection';

/**
 * Call from PlotViewComponent constructor or ngAfterViewInit:
 *
 * wirePlotChannelSelection(() => ({
 *   plotMap: this.plotMap,
 *   busMap: this.busMap,
 *   busPolygons: this.busPolygons,
 *   channelPaths: this.channelPaths,
 *   channelColors: this.channelColors,
 *   lanes: this.lanes,
 *   seedSeriesFromPlotMap: () => this.seedSeriesFromPlotMap(),
 *   resizePlot: () => this.resizePlot(),
 *   edgeAvailableResponse: this.edgeAvailableResponse
 * }));
 */
export function wirePlotChannelSelection(
  getContext: () => PlotChannelSelectionContext,
  destroyRef?: DestroyRef
): void {
  const bridge = inject(ChannelPlotBridgeService);
  const ref = destroyRef ?? inject(DestroyRef);

  bridge.channelSelection$
    .pipe(takeUntilDestroyed(ref))
    .subscribe(selection => {
      if (!selection) {
        return;
      }
      applyBusChannelSelection(getContext(), selection);
    });
}
