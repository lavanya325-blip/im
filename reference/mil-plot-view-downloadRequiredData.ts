  private async downloadRequiredData() {
    const release = await mutex.acquire();
    try {
      if (!this.edgeAvailableResponse) {
        return;
      }

      const traceBounds = this.getTraceBounds();
      if (!traceBounds) {
        return;
      }

      const visibleRange = Math.max(this.stop - this.start, this.minEdgeWidth * 1000);
      let cacheStartTime = this.start - 4 * visibleRange;
      let cacheStopTime = this.stop + 4 * visibleRange;

      cacheStartTime = Math.max(cacheStartTime, traceBounds.start);
      cacheStopTime = Math.min(cacheStopTime, traceBounds.end);
      [cacheStartTime, cacheStopTime] = this.normalizeTimeRange(cacheStartTime, cacheStopTime);

      if (this.downloadedDataStart == undefined || this.downloadedDataStop == undefined) {
        await this.appendWaveformRequest(cacheStartTime, cacheStopTime);
        this.downloadedDataStart = cacheStartTime;
        this.downloadedDataStop = cacheStopTime;
      } else if (
        d3.max([cacheStartTime, this.downloadedDataStart!])! < d3.min([cacheStopTime, this.downloadedDataStop!])!
      ) {
        await this.prependWaveformRequest(cacheStartTime, this.downloadedDataStart!);
        await this.appendWaveformRequest(this.downloadedDataStop!, cacheStopTime);
      } else {
        this.waveforms.forEach((points, key, map) => {
          if (points.length === 0) {
            return;
          }
          if (cacheStopTime <= traceBounds.start && points[0].x == traceBounds.start) {
            // no data required
          } else if (cacheStartTime > traceBounds.start) {
            // no data required
          } else {
            map.set(key, []);
          }
        });

        await this.appendWaveformRequest(cacheStartTime, cacheStopTime);
        this.downloadedDataStart = cacheStartTime;
        this.downloadedDataStop = cacheStopTime;
      }
    } finally {
      release();
    }
  }
