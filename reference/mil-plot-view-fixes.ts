/**
 * MIL plot-view fixes — paste/replace matching sections in your plot-view.component.ts
 * Fixes: 2nd+ offline load blank plot (getEdges start > end, stale window, partial EdgesAvailable).
 */

// ========== 1) Add field next to edgeAvailableResponse ==========
// private edgeAvailableResponse: ...
// private traceBoundsKey?: string;

// ========== 2) Replace resetRunState() entirely ==========
/*
private resetRunState(): void {
  this.runId++;
  this.zoomHandler?.destroy();
  this.zoomHandler = undefined;
  this.zoomStateService?.updateTransform(d3.zoomIdentity);
  if (this.waveformsvg?.nativeElement) {
    d3.select(this.waveformsvg.nativeElement).select('g.zoom-content').attr('transform', null);
  }

  this.traceBoundsKey = undefined;
  this.edgeAvailableResponse = undefined;
  this.hasValidData = false;
  this.hasData = false;
  this.lanes = [];
  this.laneHeights.clear();
  this.triggerEnabled = false;
  this.triggerFound = false;
  this.triggerTime = 0;
  this.referenceTime = 0;
  this.minEdgeWidthIsFinal = false;
  this.minEdgeWidth = 50e-9;
  this.scalesReady = false;
  this.start = 0;
  this.stop = 1;
  this.fullDomain = [0, 1];
  this.lastRenderedFrameIndex = undefined;
  this.plotRenderResolver = undefined;
  this.downloadedDataStart = undefined;
  this.downloadedDataStop = undefined;
  this.channelPaths.clear();
  this.busPolygons.clear();
  this.waveforms.clear();
  this.busMap.clear();
  this.plotMap.clear();
  this.bitLabels = [];
  this.showOverlay = false;
  this.zoomInEnabled = false;
  this.zoomOutEnabled = false;
  this.dragging = false;
}
*/

// ========== 3) Add before cleanWaveformData() ==========
/*
private normalizeTraceBounds(
  response: WaveformTypes_pb.EdgesAvailableResponse
): { start: number; end: number; key: string } | null {
  let start = response.StartTime;
  let end = response.EndTime;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  if (end < start) {
    [start, end] = [end, start];
  }
  if (end <= start + EPS) {
    return null;
  }
  return { start, end, key: `${start}:${end}` };
}

private getTraceBounds(): { start: number; end: number; key: string } | null {
  return this.edgeAvailableResponse
    ? this.normalizeTraceBounds(this.edgeAvailableResponse)
    : null;
}

private normalizeTimeRange(startTime: number, stopTime: number): [number, number] {
  let start = startTime;
  let stop = stopTime;
  if (!Number.isFinite(start) || !Number.isFinite(stop)) {
    return [0, 1];
  }
  if (stop < start) {
    [start, stop] = [stop, start];
  }
  if (stop <= start) {
    stop = start + Math.max(this.minEdgeWidth * 1000, EPS);
  }
  return [start, stop];
}
*/

// ========== 4) Replace EdgesAvailableResponse subscription ==========
/*
this.pubSubTokens.push(PubSub.subscribe('EdgesAvailableResponse', (_msgType, msg: WaveformTypes_pb.EdgesAvailableResponse) => {
  console.log('EdgesAvailableResponse', this.runId, msg);
  if (!msg) {
    return;
  }
  msg.StartTime -= EPS;
  if (!this.normalizeTraceBounds(msg)) {
    return;
  }
  this.edgeAvailableResponse = msg;
  void this.updatePlotLimits();
}));
*/

// ========== 5) InitializeRun — first lines inside case InitializeRun, before getConfig ==========
/*
this.runId++;
this.downloadedDataStart = undefined;
this.downloadedDataStop = undefined;
this.minEdgeWidthIsFinal = false;
this.traceBoundsKey = undefined;
this.start = 0;
this.stop = 1;
*/

// ========== 5b) requestBus — normalize range ==========
/*
private async requestBus(name: string, startTime: number, stopTime: number) {
  const [rangeStart, rangeStop] = this.normalizeTimeRange(startTime, stopTime);
  const busResponse = await this.coreService.ResultService.getBus({
    ProtocolName: name,
    StartTime: rangeStart,
    EndTime: rangeStop
  });
  return busResponse!.Buses.sort((a, b) => a.StartTime - b.EndTime);
}
*/

// ========== 5c) updatePlot() — use normalized clip domain ==========
// Replace domain array in toPoints with:
// const bounds = this.getTraceBounds();
// const domain: [number, number] = bounds ? [bounds.start, bounds.end] : [this.fullDomain[0], this.fullDomain[1]];

// ========== 6) Replace entire updatePlotLimits() ==========
// See mil-plot-view-updatePlotLimits.ts in same folder

// ========== 7) Replace downloadRequiredData cache block ==========
// See mil-plot-view-downloadRequiredData.ts

// ========== 8) Replace requestData() ==========
/*
async requestData(startTime: number, stopTime: number) {
  const edgesMap: Map<CommonTypes_pb.Channels, WaveformTypes_pb.EdgeCollection> = new Map();
  const [rangeStart, rangeStop] = this.normalizeTimeRange(startTime, stopTime);

  for (const channel of this.waveforms.keys()) {
    try {
      const edgeResponse = await this.coreService.ResultService.getEdges({
        Channel: channel,
        TimeBased: { StartTime: rangeStart, EndTime: rangeStop }
      });
      console.log('getEdges', channel, rangeStart, rangeStop, 'edges:', edgeResponse?.Edges?.Edges?.length, edgeResponse);
      if (edgeResponse?.Edges) {
        edgesMap.set(channel, edgeResponse.Edges);
      }
    } catch (error) {
      console.error('getEdges failed', channel, error);
    }
  }
  return edgesMap;
}
*/

// ========== 9) setupZoom onTransformEnd — replace guard + rescaleX block ==========
/*
onTransformEnd: async (finalTransform) => {
  if (!this.scalesReady || !this.xScale) {
    this.zoomHandler?.reset();
    d3.select(this.waveformsvg.nativeElement).select('g.zoom-content').attr('transform', null);
    return;
  }
  const newDomain = finalTransform.rescaleX(this.xScale).domain() as [number, number];
  await this.processDomainUpdate(newDomain);
  this.zoomStateService?.updateTransform(d3.zoomIdentity);
}
*/
