  private async updatePlotLimits() {
    const run = this.runId;

    const traceBounds = this.getTraceBounds();
    if (!traceBounds) {
      return;
    }

    const traceChanged = this.traceBoundsKey !== traceBounds.key;
    if (traceChanged) {
      this.traceBoundsKey = traceBounds.key;
      this.downloadedDataStart = undefined;
      this.downloadedDataStop = undefined;
      this.minEdgeWidthIsFinal = false;
      await this.cleanWaveformData();
    }

    if (!(this.edgeAvailableResponse && this.edgeAvailableResponse.ChannelEdgeAvailable.length > 0)) {
      return;
    }

    this.ensurePlotMapFromEdges();
    if (this.plotMap.size == 0) {
      return;
    }
    this.seedSeriesFromPlotMap();

    const dataStart = traceBounds.start;
    const dataEnd = traceBounds.end;
    this.fullDomain = [dataStart, dataEnd];

    const needsTimeWindow =
      traceChanged ||
      this.downloadedDataStart === undefined ||
      this.downloadedDataStop === undefined ||
      this.stop <= this.start ||
      this.start < dataStart ||
      this.stop > dataEnd;

    if (needsTimeWindow || this.minEdgeWidthIsFinal === false) {
      const channelWithMoreEdges = this.edgeAvailableResponse.ChannelEdgeAvailable.reduce((max, current) =>
        current.Count > max.Count ? current : max
      );

      let edgeCount = channelWithMoreEdges.Count;
      if (edgeCount > 1000) {
        edgeCount = 1000;
        this.minEdgeWidthIsFinal = true;
      }

      try {
        const response = await this.coreService.ResultService.getEdges({
          Channel: channelWithMoreEdges.Channel,
          IndexBased: { Offset: 0, Count: edgeCount }
        });
        if (run !== this.runId) {
          return;
        }
        const edgeList = response?.Edges?.Edges ?? [];
        const difference = edgeList
          .map((d: number, i: number, arr: number[]) => (i > 0 ? d - arr[i - 1] : null))
          .slice(1);
        const [minEdgeWidth] = d3.extent(difference.filter((v): v is number => v != null && v > 0));
        if (typeof minEdgeWidth === 'number' && minEdgeWidth > 0) {
          this.minEdgeWidth = minEdgeWidth;
        }
      } catch (error) {
        console.error('min edge sample failed', error);
      }

      if (needsTimeWindow) {
        this.start = dataStart;
        this.stop = Math.min(dataEnd, dataStart + this.minEdgeWidth * 1000);
        if (this.stop <= this.start) {
          this.stop = dataStart + Math.max(this.minEdgeWidth * 1000, EPS);
        }
      }

      const downloadedStart = this.downloadedDataStart;
      const downloadedStop = this.downloadedDataStop;

      try {
        console.log(
          'range',
          this.start,
          this.stop,
          'available',
          dataStart,
          dataEnd,
          'minEdgeWidth',
          this.minEdgeWidth
        );
        await this.downloadRequiredData();
        if (run !== this.runId) {
          return;
        }
      } catch (error) {
        console.error('downloadRequiredData failed', error);
      }

      const hasPoints =
        [...this.waveforms.values()].some(points => points.length > 0) ||
        [...this.busMap.values()].some(packets => packets.length > 0);

      if (this.downloadedDataStart === downloadedStart && this.downloadedDataStop === downloadedStop && !hasPoints) {
        return;
      }

      console.log('updatePlotLimits hasPoints', hasPoints, [...this.waveforms.keys()]);
      if (hasPoints) {
        this.hasValidData = true;
        this.hasData = true;
        this.resizePlot();
      }
    }
  }
