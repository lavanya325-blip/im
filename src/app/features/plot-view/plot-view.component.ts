import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import * as d3 from 'd3';
import { Mutex } from 'async-mutex';
import { BusPolygon, PacketBus, PlotTrack, Point } from './models/plot-track.model';
import { EdgeCollection, TraceData } from './models/trace-data.model';
import { toEngineeringTime, toPoints, toRawPoints } from './extensions/plot-extensions';
import { BusExtensions } from './extensions/bus-extensions';

import * as WaveformTypes_pb from '../../../protos/WaveformTypes';
import * as CommonTypes_pb from '../../../protos/CommonTypes';
import { CoreService } from '../../core/services/core.services';
import * as DecoderTypes_pb from '../../../protos/DecoderTypes';
import { ConfigurationDtos } from '../../core/dtos/app.config.service.dtos';
import { PlotInfoDto, ProtocolFrameDto } from '../../core/dtos/result.service.dtos';
import { HardwareStatus, HardwareStatusType } from '../../../protos/CaptureService';
import * as annotationEx from '../extensions/result.annotations';
import { processBusArray } from '../extensions/bus.extensions.i3c';
import {
  edgeTimes,
  entriesFromEdges,
  initialVisibleWindow,
  isWaveformChannel,
  mergeEdgeChannels,
  positiveEdgeWidth
} from './plot-edge-pipeline';

/** Toolbar ids — keep this list here so templates type-check even if plot-track.model.ts is stale. */
export type PlotTool =
  | 'snapshot'
  | 'expand'
  | 'select'
  | 'zoomIn'
  | 'zoomOut'
  | 'pan'
  | 'fit'
  | 'move'
  | 'cursor'
  | 'grid'
  | 'flag';

const EPS = 1e-12;
const mutex = new Mutex();
const LANE_COLORS = ['#5B9BD5', '#E77352', '#F5C518', '#C084FC', '#F472B6', '#4ADE80'];

export type Padding = { left: number; right: number; top: number; bottom: number };

type PlotEntry = {
  name: string;
  channel?: CommonTypes_pb.Channels;
  allowSelection: boolean;
  selected: boolean;
};

declare const PubSub: {
  subscribe(topic: string, handler: (msgType: string, msg: any) => void): string;
  unsubscribe?(token: string): void;
};

@Component({
  selector: 'app-plot-view',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './plot-view.component.html',
  styleUrl: './plot-view.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PlotViewComponent implements AfterViewInit, OnDestroy, OnChanges {
  @ViewChild('waveformContainer') waveformContainer?: ElementRef<HTMLElement>;
  @ViewChild('waveformsvg', { static: true }) waveformsvg!: ElementRef<SVGElement>;
  private waveformSVG_Padding!: Padding;
  private pubSubTokens: string[] = [];

  getLegendDisplayName(plot: string) {
    if (plot === 'SDA0' && Array.from(this.plotMap.values()).filter(p => p.name.startsWith('SDA') && p.selected).length === 1) {
      return 'SDA';
    }

    return plot;
  }
  triggerFound = false;
  hasValidData = false;
  xScale!: d3.ScaleLinear<number, number>;
  yScale!: d3.ScaleLinear<number, number>;
  private scalesReady = false;
  showBits = false;

  readonly tracks: PlotTrack[] = [
    { id: 'busA', name: 'Bus A', subtitle: 'MIL 1553', color: '#5B9BD5', kind: 'bus' },
    { id: 'busB', name: 'Bus B', subtitle: 'MIL 1553', color: '#E77352', kind: 'bus' },
    { id: 'ch1', name: 'Channel 1', subtitle: 'Async', color: '#F5C518', kind: 'channel' },
    { id: 'ch2', name: 'Channel 2', subtitle: 'Async', color: '#C084FC', kind: 'channel' },
    { id: 'ch3', name: 'Channel 3', subtitle: 'Async', color: '#F472B6', kind: 'channel' },
    { id: 'ch4', name: 'Channel 4', subtitle: 'Async', color: '#4ADE80', kind: 'channel' }
  ];

  /** Live rows. Empty until plotMap is built; the template then falls back to `tracks`. */
  lanes: PlotTrack[] = [];
  private laneHeights = new Map<string, number>();

  readonly tools: { id: string; icon: string; label: string; order: number }[] = [
    { id: 'snapshot', icon: 'camera_alt', label: 'Camera', order: 0 },
    { id: 'expand', icon: 'open_in_full', label: 'Expand', order: 1 },
    { id: 'select', icon: 'mouse', label: 'Mouse', order: 2 },
    { id: 'zoomIn', icon: 'zoom_in', label: 'Zoom in', order: 3 },
    { id: 'zoomOut', icon: 'zoom_out', label: 'Zoom out', order: 4 },
    { id: 'pan', icon: 'pan_tool', label: 'Pan', order: 5 },
    { id: 'move', icon: 'open_with', label: 'Drag pan', order: 6 },
    { id: 'cursor', icon: 'calendar_month', label: 'Calendar', order: 7 },
    { id: 'grid', icon: 'grid_3x3', label: 'Grid', order: 8 },
    { id: 'flag', icon: 'table_chart', label: 'Table view', order: 9 }
  ];

  hasData = false;
  @HostBinding('class.is-fullscreen') isFullscreen = false;
  activeTool: string = 'select';
  gridEnabled = true;
  decodeEnabled = true;
  cursorEnabled = false;
  selectEnabled = false;
  cursorTimes: number[] = [];
  markerTimes: number[] = [];
  flags: number[] = [];

  showOverlay = false;
  overlayX = 0;
  overlayWidth = 0;
  private overlayx0 = 0;
  private dragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

  private configuration_I3C?: ConfigurationDtos;

  private downloadedDataStart?: number;
  private downloadedDataStop?: number;
  private minEdgeWidthIsFinal = false;
  private configuration?: ConfigurationDtos;
  private triggerEnabled = false;

  plotWidth = 800;
  plotHeight = 520;
  readonly axisHeight = 24;
  readonly waveHeight = 52;
  readonly decodeGap = 4;
  laneGap = 8;
  readonly decodeHeight = 19;

  gridLines: { x: number; label: string }[] = [];

  public waveforms: Map<CommonTypes_pb.Channels, Point[]> = new Map();
  public busMap: Map<string, DecoderTypes_pb.PacketBus[]> = new Map();
  private fullDomain: [number, number] = [0, 1];
  private start = 0;
  private stop = 1;
  private minEdgeWidth = 50e-9;
  private referenceTime = 0;
  private resizeObserver?: ResizeObserver;
  private readonly lineGenerator = d3.line<Point>().curve(d3.curveStepAfter);

  private readonly bisector = d3.bisector((d: Point) => d.x);
  private readonly busBisectorLeft = d3.bisector((d: DecoderTypes_pb.PacketBus) => d.StartTime).left;
  private readonly busBisectorRight = d3.bisector((d: DecoderTypes_pb.PacketBus) => d.EndTime).right;
  private plotRenderResolver?: (frameIndex: number) => void;
  private lastRenderedFrameIndex?: number;

  private edgeAvailableResponse: WaveformTypes_pb.EdgesAvailableResponse | undefined;
  public plotMap: Map<string, PlotEntry> = new Map();
  channelPaths: Map<string, { index: number; channel: CommonTypes_pb.Channels; yScale: d3.ScaleLinear<number, number>; path: string }> = new Map();
  busPolygons: Map<string, { index: number; yScale: d3.ScaleLinear<number, number>; polygons: BusPolygon[] }> = new Map();

  private triggerTime = 0;
  @Input() selectedFrame?: ProtocolFrameDto;
  annotations: annotationEx.TextAnnotationModel[] = [];

  @Input() set TriggerTime(time: number) {
    this.triggerTime = time;
  }

  get TriggerTime(): number {
    return this.triggerTime;
  }

  constructor(private cdr: ChangeDetectorRef, private coreService: CoreService) {}

  get visibleTracks(): PlotTrack[] {
    return this.lanes.length ? this.lanes : this.tracks;
  }

  /** Snapshot for the template. Map.keys() does not notify OnPush when entries are added. */
  get legendPlots(): string[] {
    return [...this.plotMap.entries()].filter(([, entry]) => entry.selected).map(([key]) => key);
  }

  get channelPathList(): { id: string; channel: number; path: string; color: string }[] {
    return [...this.channelPaths.entries()].map(([id, value]) => ({
      id,
      channel: value.channel as unknown as number,
      path: value.path,
      color: this.colorFor(id)
    }));
  }

  get busPolygonList(): { id: string; color: string; polygons: BusPolygon[] }[] {
    return [...this.busPolygons.entries()].map(([id, value]) => ({
      id,
      color: this.colorFor(id),
      polygons: value.polygons ?? []
    }));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['selectedFrame']) {
      if (this.selectedFrame) {
        this.GotoTime(this.selectedFrame.StartTime, this.selectedFrame.EndTime);
      }
    }
  }

  async GotoTime(startTime: number, stopTime: number) {
    console.log('zoom to time');

    let start = startTime;
    let stop = stopTime;

    const diff = stop - start;
    start -= (0.05 * diff) - EPS;
    stop += (0.05 * diff);

    if (this.start === start && this.stop === stop) {
      return;
    }

    this.start = start;
    this.stop = stop;

    await this.cleanWaveformData();
    await this.downloadRequiredData();

    this.resizePlot();
  }

  ngAfterViewInit(): void {
    this.waveformSVG_Padding = this.getPadding(this.waveformsvg.nativeElement);
    this.observeSize();

    this.pubSubTokens.push(PubSub.subscribe('EdgesAvailableResponse', (_msgType, msg: WaveformTypes_pb.EdgesAvailableResponse) => {
      if (msg) {
        msg.StartTime -= EPS;
        this.edgeAvailableResponse = msg;
        void this.updatePlotLimits();
      } else {
        console.error('Error in edges subscription:', JSON.stringify(msg));
      }
    }));

    this.pubSubTokens.push(PubSub.subscribe('PlotInfoDto', (_msgType, msg: PlotInfoDto) => {
      if (msg && msg.ReferenceStartTime) {
        this.TriggerTime = msg.ReferenceStartTime;
      }
    }));

    this.pubSubTokens.push(PubSub.subscribe('HardwareStatus', (_msgType, msg: HardwareStatus) => {
      if (msg) {
        if (this.triggerEnabled && !this.triggerFound && msg.StatusType == HardwareStatusType.Trigger_Found) {
          this.triggerFound = true;
          this.TriggerTime = msg.Timestamp;
          this.cdr.detectChanges();
        }
      }
    }));

    this.pubSubTokens.push(PubSub.subscribe('SystemStatusUpdate', async (_type, msg: CommonTypes_pb.SystemStatusUpdate) => {
      if (!msg) {
        return;
      }
      switch (msg.CurrentState) {
        case CommonTypes_pb.SystemStates.InitializeRun: {
          this.configuration_I3C = await this.coreService.AppConfigService.getConfig();
          this.configuration = this.configuration_I3C;

          console.log('PlotViewComponent:', this.configuration_I3C);

          this.triggerEnabled = false;

          const scl = this.configuration_I3C?.SCL;
          const sdaList = this.configuration_I3C?.SDAs ?? [];

          if (this.plotMap.size === 0) {
            if (scl != null) {
              this.plotMap.set('SCL', { name: 'SCL', channel: scl, allowSelection: false, selected: true });
            }

            for (let index = 0; index < sdaList.length; index++) {
              this.plotMap.set('SDA' + index, {
                name: 'SDA' + index,
                channel: sdaList[index],
                allowSelection: index > 0,
                selected: index == 0
              });
            }

            if (this.configuration_I3C?.ProtocolName) {
              this.plotMap.set('BUS', { name: this.configuration_I3C.ProtocolName, allowSelection: false, selected: true });
            }
          }

          console.log('Plot map', this.plotMap);

          // The DAT import often publishes edges before this state. Pick them up now.
          if (this.edgeAvailableResponse) {
            await this.updatePlotLimits();
          } else {
            this.resizePlot();
          }
          break;
        }

        case CommonTypes_pb.SystemStates.CleanupRun:
        case CommonTypes_pb.SystemStates.Ready:
          await this.cleanWaveformData();
          this.edgeAvailableResponse = undefined;
          this.hasValidData = false;
          this.hasData = false;
          this.lanes = [];
          this.annotations = [];
          this.triggerEnabled = false;
          this.triggerFound = false;
          this.triggerTime = 0;
          this.resizePlot();
          break;
      }
    }));
  }

  /**
   * I3C does not parse the file inside the plot. If a caller still hands the
   * component a TraceData object, fold it into the same maps `updatePlot` draws.
   */
  loadTrace(data: TraceData | null): void {
    if (!data) {
      this.hasData = false;
      this.hasValidData = false;
      this.lanes = [];
      this.cdr.markForCheck();
      return;
    }

    this.plotMap.clear();
    this.channelPaths.clear();
    this.busPolygons.clear();
    this.waveforms.clear();
    this.busMap.clear();

    let index = 1;
    Object.entries(data.channels).forEach(([id, collection]) => {
      const channel = index as unknown as CommonTypes_pb.Channels;
      this.plotMap.set(id, { name: id, channel, allowSelection: true, selected: true });
      this.waveforms.set(channel, this.edgesToWaveform(collection));
      this.channelPaths.set(id, { index: index++, channel, yScale: d3.scaleLinear(), path: '' });
    });
    Object.entries(data.buses).forEach(([id, packets]) => {
      this.plotMap.set(id, { name: id, allowSelection: false, selected: true });
      this.busMap.set(id, packets as DecoderTypes_pb.PacketBus[]);
      this.busPolygons.set(id, { index: index++, yScale: d3.scaleLinear(), polygons: [] });
    });

    this.minEdgeWidth = data.minEdgeWidth > 0 ? data.minEdgeWidth : 50e-9;
    this.referenceTime = data.referenceTime;
    this.fullDomain = [data.startTime, data.endTime];
    this.start = data.startTime;
    this.stop = data.endTime > data.startTime ? data.endTime : data.startTime + this.minEdgeWidth * 1000;
    this.edgeAvailableResponse = {
      StartTime: data.startTime,
      EndTime: data.endTime,
      ChannelEdgeAvailable: []
    } as WaveformTypes_pb.EdgesAvailableResponse;

    this.markDataReady();
    this.resizePlot();
  }

  getPadding(element: SVGElement): Padding {
    const computedStyle = window.getComputedStyle(element);
    return {
      left: parseFloat(computedStyle.paddingLeft) || 0,
      right: parseFloat(computedStyle.paddingRight) || 0,
      top: parseFloat(computedStyle.paddingTop) || 0,
      bottom: parseFloat(computedStyle.paddingBottom) || 0
    };
  }

  private ensurePlotMapFromConfiguration(): void {
    if (this.plotMap.size > 0 || !this.configuration) {
      return;
    }
    const scl = this.configuration.SCL;
    if (scl != null) {
      this.plotMap.set('SCL', { name: 'SCL', channel: scl, allowSelection: false, selected: true });
    }
    const sdaList = this.configuration.SDAs ?? [];
    sdaList.forEach((channel, index) => {
      this.plotMap.set('SDA' + index, {
        name: 'SDA' + index,
        channel,
        allowSelection: index > 0,
        selected: index === 0
      });
    });
    if (this.configuration.ProtocolName) {
      this.plotMap.set('BUS', { name: this.configuration.ProtocolName, allowSelection: false, selected: true });
    }
  }

  /** Trace import publishes edges before InitializeRun on some shells. Build rows from the edge list. */
  private ensurePlotMapFromEdges(): void {
    if (this.plotMap.size > 0 || !this.edgeAvailableResponse) {
      return;
    }
    for (const entry of entriesFromEdges(this.edgeAvailableResponse.ChannelEdgeAvailable)) {
      this.plotMap.set(entry.key, {
        name: entry.name,
        channel: entry.channel as CommonTypes_pb.Channels,
        allowSelection: true,
        selected: true
      });
    }
    if (this.plotMap.size > 0) {
      this.plotMap.set('BUS', {
        name: this.configuration?.ProtocolName || this.configuration_I3C?.ProtocolName || 'BUS',
        allowSelection: false,
        selected: true
      });
    }
  }

  /**
   * Create a waveform series for every selected channel, including channel 0.
   * Also add channels that exist in the uploaded file but not in configuration.
   */
  private ensureSeriesForEdges(): void {
    this.ensurePlotMapFromConfiguration();
    this.ensurePlotMapFromEdges();

    if (this.edgeAvailableResponse) {
      const merged = mergeEdgeChannels(
        [...this.plotMap.entries()].map(([key, entry]) => ({
          key,
          name: entry.name,
          channel: entry.channel as number | undefined,
          selected: entry.selected
        })),
        this.edgeAvailableResponse.ChannelEdgeAvailable
      );
      for (const entry of merged) {
        if (this.plotMap.has(entry.key)) {
          continue;
        }
        this.plotMap.set(entry.key, {
          name: entry.name,
          channel: entry.channel as CommonTypes_pb.Channels,
          allowSelection: true,
          selected: true
        });
      }
    }

    let index = 1;
    this.plotMap.forEach((entry, key) => {
      if (!entry.selected) {
        return;
      }
      if (isWaveformChannel(entry.channel as number | undefined)) {
        const channel = entry.channel as CommonTypes_pb.Channels;
        if (!this.waveforms.has(channel)) {
          this.waveforms.set(channel, []);
        }
        const existing = this.channelPaths.get(key);
        if (existing) {
          existing.index = index++;
          existing.channel = channel;
        } else {
          this.channelPaths.set(key, { index: index++, channel, yScale: d3.scaleLinear(), path: '' });
        }
      } else {
        if (!this.busMap.has(key)) {
          this.busMap.set(key, []);
        }
        const existing = this.busPolygons.get(key);
        if (existing) {
          existing.index = index++;
        } else {
          this.busPolygons.set(key, { index: index++, yScale: d3.scaleLinear(), polygons: [] });
        }
      }
    });
  }

  private seedSeriesFromPlotMap(): void {
    this.ensureSeriesForEdges();
  }

  private async cleanWaveformData(): Promise<void> {
    const release = await mutex.acquire();
    try {
      for (const channel of this.waveforms.keys()) {
        this.waveforms.set(channel, []);
      }
      for (const bus of this.busMap.keys()) {
        this.busMap.set(bus, []);
      }
      this.downloadedDataStart = undefined;
      this.downloadedDataStop = undefined;
    } finally {
      release();
    }
  }

  private async updatePlotLimits() {
    console.log('edges came');
    if (!this.edgeAvailableResponse || this.edgeAvailableResponse.ChannelEdgeAvailable.length === 0) {
      return;
    }

    const dataStart = this.edgeAvailableResponse.StartTime;
    const dataEnd = this.edgeAvailableResponse.EndTime;
    this.fullDomain = [dataStart, dataEnd > dataStart ? dataEnd : dataStart + this.minEdgeWidth * 1000];

    this.ensureSeriesForEdges();
    if (this.waveforms.size === 0) {
      console.log('update limits: plot map has no waveform channels yet');
      this.cdr.markForCheck();
      return;
    }

    if ((this.downloadedDataStart == undefined && this.downloadedDataStop == undefined) || this.minEdgeWidthIsFinal == false) {
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
          IndexBased: { Offset: 0, Count: Math.max(2, edgeCount) }
        });
        const times: number[] = edgeTimes(response?.Edges?.Edges);
        const difference = times.slice(1).map((value: number, index: number) => value - times[index]).filter((value: number) => value > 0);
        const [minEdgeWidth, maxEdgeWidth] = d3.extent(difference);
        this.minEdgeWidth = positiveEdgeWidth(minEdgeWidth);
        console.log('update min/ max edges', minEdgeWidth, maxEdgeWidth, this.start, this.stop, 'channel', channelWithMoreEdges.Channel);
      } catch (error) {
        console.error('updatePlotLimits: edge sample failed', error);
        this.minEdgeWidth = positiveEdgeWidth(this.minEdgeWidth);
      }

      if (this.downloadedDataStart === undefined && this.downloadedDataStop === undefined) {
        const [start, stop] = initialVisibleWindow(dataStart, this.minEdgeWidth);
        const domainEnd = this.fullDomain[1];
        this.start = start;
        this.stop = domainEnd > start ? Math.min(stop, domainEnd) : stop;
        if (!(this.stop > this.start)) {
          this.stop = this.start + positiveEdgeWidth(this.minEdgeWidth) * 1000;
        }
      }

      const downloadedStart = this.downloadedDataStart;
      const downloadedStop = this.downloadedDataStop;

      try {
        await this.downloadRequiredData();
      } catch (error) {
        console.error('downloadRequiredData failed', error);
      }

      const hasPoints = [...this.waveforms.values()].some(points => points.length > 0);
      const windowUnchanged = this.downloadedDataStart === downloadedStart && this.downloadedDataStop === downloadedStop;
      if (windowUnchanged && this.hasValidData && !hasPoints) {
        return;
      }

      if (hasPoints || this.downloadedDataStart !== undefined) {
        this.markDataReady();
      }

      this.resizePlot();
    }
  }

  private markDataReady(): void {
    this.hasValidData = true;
    this.hasData = true;
  }

  private async downloadRequiredData() {
    const release = await mutex.acquire();
    try {
      console.log('downloadRequiredData: entered');
      if (!this.edgeAvailableResponse) {
        return;
      }

      const visibleRange = Math.max(this.stop - this.start, this.minEdgeWidth);
      let cacheStartTime = this.start - 4 * visibleRange;
      let cacheStopTime = this.stop + 4 * visibleRange;

      if (this.edgeAvailableResponse.StartTime > cacheStartTime) {
        cacheStartTime = this.edgeAvailableResponse.StartTime;
      }
      if (this.edgeAvailableResponse.EndTime < cacheStopTime && this.edgeAvailableResponse.EndTime > cacheStartTime) {
        cacheStopTime = this.edgeAvailableResponse.EndTime;
      }

      if (this.downloadedDataStart == undefined || this.downloadedDataStop == undefined) {
        await this.appendWaveformRequest(cacheStartTime, cacheStopTime);
        this.downloadedDataStart = cacheStartTime;
        this.downloadedDataStop = cacheStopTime;
      } else if (d3.max([cacheStartTime, this.downloadedDataStart!])! < d3.min([cacheStopTime, this.downloadedDataStop!])!) {
        await this.prependWaveformRequest(cacheStartTime, this.downloadedDataStart!);
        await this.appendWaveformRequest(this.downloadedDataStop!, cacheStopTime);
      } else {
        this.waveforms.forEach((points, key, map) => {
          if (points.length === 0) {
            return;
          }
          if (cacheStopTime <= this.edgeAvailableResponse!.StartTime && points[0].x == this.edgeAvailableResponse!.StartTime) {
            // no data required
          } else if (cacheStartTime > this.edgeAvailableResponse!.StartTime) {
            // no data required
          } else {
            map.set(key, []);
          }
        });
        console.log('downloadRequiredData: discard previous downloaded data');
        await this.appendWaveformRequest(cacheStartTime, cacheStopTime);
        this.downloadedDataStart = cacheStartTime;
        this.downloadedDataStop = cacheStopTime;
      }
    } finally {
      console.log('downloadRequiredData: exited');
      release();
    }
  }

  private async prependWaveformRequest(startTime: number, stopTime: number) {
    if (this.downloadedDataStart == undefined || this.downloadedDataStart <= startTime) {
      for (const element of this.waveforms) {
        const channelWfm = element[1];
        const filterIndex = this.bisector.left(channelWfm, startTime);
        if (channelWfm.length > 0 && filterIndex < channelWfm.length && channelWfm.length - filterIndex > 0) {
          const edges = channelWfm.slice(filterIndex);
          console.log('prependWaveformRequest: remove waveform from top', element[0], edges);
          this.waveforms.set(element[0], edges);
        }
      }

      for (const busMapItem of this.busMap) {
        const bus = busMapItem[1];
        const filterIndex = this.busBisectorLeft(bus, startTime);
        console.log('prependWaveformRequest: remove bus from top', bus, filterIndex, startTime, stopTime);
        this.busMap.set(busMapItem[0], bus.slice(filterIndex));
      }
    } else {
      const responseData = await this.requestData(startTime, stopTime);

      for (const channelResponse of responseData) {
        const channelWfm = this.waveforms.get(channelResponse[0]) ?? [];
        const points = this.toRawPoints(channelResponse[1].FirstEdge == WaveformTypes_pb.WaveEdgeType.RISE, channelResponse[1].Edges);
        const edges = points.concat(channelWfm);
        console.log('prependWaveformRequest: prepend new data', channelResponse[0], edges);
        this.waveforms.set(channelResponse[0], edges);
      }

      for (const busMapItem of this.busMap) {
        const bus = busMapItem[1];
        const busResponseData = await this.fetchBus(busMapItem[0], startTime, stopTime);
        let prependedBus: DecoderTypes_pb.PacketBus[] = bus;
        if (bus.length > 0) {
          if (busResponseData.length > 0) {
            const busIndex = this.busBisectorRight(bus, busResponseData.at(-1)!.EndTime);
            prependedBus = busResponseData.concat(bus.slice(busIndex));
          }
        } else {
          prependedBus = busResponseData;
        }
        this.busMap.set(busMapItem[0], prependedBus);
      }
    }

    this.downloadedDataStart = startTime;
  }

  private async appendWaveformRequest(startTime: number, stopTime: number) {
    if (this.downloadedDataStop && this.downloadedDataStop >= stopTime) {
      for (const element of this.waveforms) {
        const channelWfm = this.waveforms.get(element[0]) ?? [];
        const endIndex = this.bisector.right(channelWfm, stopTime);
        if (channelWfm.length > 0 && endIndex < channelWfm.length && endIndex > 0) {
          const edges = channelWfm.slice(0, endIndex);
          console.log('appendWaveformRequest: remove waveform from bottom', element[0], edges);
          this.waveforms.set(element[0], edges);
        }
      }

      for (const busMapItem of this.busMap) {
        const bus = busMapItem[1];
        const endIndex = this.busBisectorLeft(bus, stopTime);
        console.log('appendWaveformRequest: remove bus from bottom', bus, endIndex, startTime, stopTime);
        this.busMap.set(busMapItem[0], bus.slice(0, endIndex));
      }
    } else {
      const responseData = await this.requestData(startTime, stopTime);

      for (const channelResponse of responseData) {
        const channelWfm = this.waveforms.get(channelResponse[0]) ?? [];
        const points = this.toRawPoints(channelResponse[1].FirstEdge == WaveformTypes_pb.WaveEdgeType.RISE, channelResponse[1].Edges);
        const edges = channelWfm.concat(points);
        console.log('appendWaveformRequest: append new data', channelResponse[0], this.edgeAvailableResponse, edges);
        this.waveforms.set(channelResponse[0], edges);
      }

      for (const busMapItem of this.busMap) {
        const bus = busMapItem[1];
        const busResponseData = await this.fetchBus(busMapItem[0], startTime, stopTime);
        let appendedBus: DecoderTypes_pb.PacketBus[] = bus;
        if (bus.length > 0) {
          if (busResponseData.length > 0) {
            const busIndex = this.busBisectorLeft(bus, busResponseData[0].StartTime);
            appendedBus = bus.slice(0, busIndex).concat(busResponseData);
          }
        } else {
          appendedBus = busResponseData;
        }
        appendedBus = this.relabelSetdasa(appendedBus);
        this.busMap.set(busMapItem[0], appendedBus);
        console.log('appendWaveformRequest: bus updated', appendedBus);
      }
    }
    this.downloadedDataStop = stopTime;
  }

  private relabelSetdasa(appendedBus: PacketBus[]): PacketBus[] {
    const hasSetdasa = appendedBus.some(item => item.Content?.includes('SETDASA') || item.Content?.includes('SETNEWDA'));
    const index = appendedBus.findIndex((item, idx) =>
      hasSetdasa &&
      (item.Content === 'ACK' || item.Content === 'NACK') &&
      appendedBus[idx - 2]?.Content?.startsWith('DynAddr')
    );
    if (!hasSetdasa || index === -1) {
      return appendedBus;
    }
    return appendedBus.map((item, idx) => {
      if (idx === index - 1) {
        return { ...item, Content: ' ' };
      }
      if (idx === index) {
        return { ...item, Content: 'T' };
      }
      return item;
    });
  }

  private async fetchBus(key: string, startTime: number, stopTime: number): Promise<DecoderTypes_pb.PacketBus[]> {
    const protocol = this.plotMap.get(key)?.name || this.configuration?.ProtocolName || this.configuration_I3C?.ProtocolName;
    if (!protocol) {
      return [];
    }
    try {
      return await this.requestBus(protocol, startTime, stopTime);
    } catch (error) {
      console.error('fetchBus failed', protocol, error);
      return [];
    }
  }

  private async requestBus(name: string, startTime: number, stopTime: number) {
    const busResponse = await this.coreService.ResultService.getBus({ ProtocolName: name, StartTime: startTime, EndTime: stopTime });
    return busResponse!.Buses.sort((a, b) => a.StartTime - b.StartTime);
  }

  async requestData(startTime: number, stopTime: number) {
    const edgesMap: Map<CommonTypes_pb.Channels, WaveformTypes_pb.EdgeCollection> = new Map();

    for (const channel of this.waveforms.keys()) {
      const edgeResponse = await this.coreService.ResultService.getEdges({
        Channel: channel,
        TimeBased: { StartTime: startTime, EndTime: stopTime }
      });
      if (edgeResponse?.Edges) {
        edgesMap.set(channel, edgeResponse.Edges);
      }
    }

    const sclChannel = this.configuration_I3C?.SCL ?? this.configuration?.SCL;
    const sclEdges = sclChannel != null ? edgesMap.get(sclChannel) : undefined;
    if (sclEdges?.Edges.length && this.edgeAvailableResponse && Math.abs(sclEdges.Edges[0] - this.edgeAvailableResponse.StartTime) <= 2 * EPS) {
      edgesMap.forEach((value, key) => {
        if (value.FirstEdge === WaveformTypes_pb.WaveEdgeType.FALL) {
          value.FirstEdge = WaveformTypes_pb.WaveEdgeType.RISE;
          value.Edges.unshift(this.edgeAvailableResponse!.StartTime);
          edgesMap.set(key, value);
          console.log('requestData(): Pull SCL / SDA HIGH 1st edge corrected');
        }
      });
    }

    return edgesMap;
  }

  private toRawPoints(firstEdge: boolean, edges: number[]) {
    return edgeTimes(edges).map((x: number, index: number) => ({ x, y: this.getWaveformState(firstEdge, index) }));
  }

  private getWaveformState(firstEdge: boolean, index: number) {
    return index % 2 == (firstEdge ? 0 : 1) ? 1 : 0;
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    for (const token of this.pubSubTokens) {
      PubSub.unsubscribe?.(token);
    }
  }

  trackTrack(_index: number, track: PlotTrack): string {
    return track.id;
  }

  trackByChannel(_index: number, path: { channel: number; id?: string }): number | string {
    return path.id ?? path.channel;
  }

  colorFor(id: string): string {
    return this.visibleTracks.find(track => track.id === id)?.color ?? LANE_COLORS[0];
  }

  plotCursor(): string {
    switch (this.activeTool) {
      case 'zoomIn':
        return 'zoom-in';
      case 'zoomOut':
        return 'zoom-out';
      case 'pan':
        return this.dragging ? 'grabbing' : 'grab';
      case 'move':
        return 'move';
      case 'cursor':
      case 'flag':
        return 'crosshair';
      default:
        return 'default';
    }
  }

  toggleFullscreen(): void {
    this.isFullscreen = !this.isFullscreen;
    this.cdr.detectChanges();
    requestAnimationFrame(() => {
      this.measurePlot();
      this.resizePlot();
      this.cdr.markForCheck();
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isFullscreen) {
      this.toggleFullscreen();
    }
  }

  laneHeight(track: PlotTrack): number {
    return this.laneHeights.get(track.id) ?? this.waveHeight + (track.kind === 'bus' && this.decodeEnabled ? this.decodeGap + this.decodeHeight : 0) + this.laneGap;
  }

  laneTop(trackIndex: number): number {
    const rows = this.visibleTracks;
    let top = 0;
    for (let i = 0; i < trackIndex && i < rows.length; i++) {
      top += this.laneHeight(rows[i]);
    }
    return top;
  }

  contentHeight(): number {
    return this.laneTop(this.visibleTracks.length) + this.axisHeight;
  }

  decodeTop(trackIndex: number): number {
    return this.laneTop(trackIndex) + this.waveHeight + this.decodeGap;
  }

  get cursorX(): number {
    if (!this.scalesReady || this.cursorTimes.length === 0) {
      return -1;
    }
    return this.xScale(this.cursorTimes[this.cursorTimes.length - 1]);
  }

  get markers(): number[] {
    if (!this.scalesReady) {
      return [];
    }
    return this.markerTimes.map(time => this.xScale(time));
  }

  isToolLit(tool: string): boolean {
    if (tool === 'grid') {
      return this.gridEnabled;
    }
    if (tool === 'cursor') {
      return this.cursorEnabled || this.activeTool === 'cursor';
    }
    if (tool === 'expand') {
      return this.isFullscreen;
    }
    if (tool === 'flag') {
      return this.decodeEnabled;
    }
    if (tool === 'select') {
      return this.activeTool === 'select' || this.selectEnabled;
    }
    return this.activeTool === tool;
  }

  onTool(tool: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();

    switch (tool) {
      case 'snapshot':
        this.SaveImage();
        break;
      case 'expand':
        this.toggleFullscreen();
        break;
      case 'grid':
        this.gridEnabled = !this.gridEnabled;
        this.resizePlot();
        break;
      case 'flag':
        this.decodeEnabled = !this.decodeEnabled;
        this.showBits = this.decodeEnabled;
        this.measurePlot();
        this.resizePlot();
        break;
      case 'cursor':
        this.activeTool = 'cursor';
        this.cursorEnabled = true;
        break;
      case 'select':
        this.activeTool = 'select';
        this.selectEnabled = true;
        this.cursorEnabled = false;
        break;
      case 'zoomIn':
      case 'zoomOut':
      case 'pan':
      case 'move':
        this.activeTool = tool;
        this.selectEnabled = false;
        this.cursorEnabled = false;
        break;
      case 'fit':
        this.onFitClick(event);
        break;
    }
    this.cdr.markForCheck();
  }

  onMouseEnableClick(event: Event): void {
    this.onTool('select', event);
  }

  onZoomInClick(event: Event): void {
    this.onTool('zoomIn', event);
  }

  onZoomOutClick(event: Event): void {
    this.onTool('zoomOut', event);
  }

  onPanClick(event: Event): void {
    this.onTool('pan', event);
  }

  onFitClick(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.start = this.fullDomain[0];
    this.stop = this.fullDomain[1];
    this.clampWindow();
    void this.downloadRequiredData().then(() => this.resizePlot());
  }

  onCursorEnableClick(_model: unknown, event?: Event): void {
    this.onTool('cursor', event);
  }

  onEnableGrid(event: Event): void {
    this.onTool('grid', event);
  }

  onBitsClick(event: Event): void {
    this.onTool('flag', event);
  }

  SaveImage(): void {
    this.capturePlot();
  }

  waveformMousemove(event: MouseEvent): void {
    this.onDocumentMove(event);
  }

  waveformMouseup(event: MouseEvent): void {
    this.onDocumentUp(event);
  }

  waveform_mousedown(event: MouseEvent): void {
    this.waveformMousedown(event);
  }

  waveform_mousemove(event: MouseEvent): void {
    this.waveformMousemove(event);
  }

  waveform_mouseup(event: MouseEvent): void {
    this.waveformMouseup(event);
  }

  waveformMousedown(event: MouseEvent): void {
    if (!(this.hasData || this.hasValidData) || event.button !== 0 || !this.scalesReady) {
      return;
    }

    const x = this.pointerX(event);
    this.lastPointerX = x;
    this.lastPointerY = event.clientY;

    if (this.activeTool === 'zoomIn') {
      this.dragging = true;
      this.showOverlay = true;
      this.overlayx0 = x;
      this.overlayX = x;
      this.overlayWidth = 0;
      event.preventDefault();
      return;
    }

    if (this.activeTool === 'zoomOut') {
      this.zoomAround(x, 2);
      event.preventDefault();
      return;
    }

    if (this.activeTool === 'cursor') {
      const time = this.xScale.invert(x);
      this.cursorTimes = [...this.cursorTimes.slice(-1), time];
      this.cursorEnabled = true;
      this.cdr.markForCheck();
      event.preventDefault();
      return;
    }

    if (this.activeTool === 'select') {
      this.dragging = true;
      this.showOverlay = true;
      this.overlayx0 = x;
      this.overlayX = x;
      this.overlayWidth = 0;
      this.markerTimes = [this.xScale.invert(x)];
      event.preventDefault();
      return;
    }

    if (this.activeTool === 'pan' || this.activeTool === 'move') {
      this.dragging = true;
      event.preventDefault();
    }
  }

  @HostListener('document:mousemove', ['$event'])
  onDocumentMove(event: MouseEvent): void {
    if (!this.dragging) {
      return;
    }

    const x = this.pointerX(event);
    const dx = x - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = x;
    this.lastPointerY = event.clientY;

    if (this.showOverlay && (this.activeTool === 'zoomIn' || this.activeTool === 'select')) {
      if (x >= this.overlayx0) {
        this.overlayX = this.overlayx0;
        this.overlayWidth = x - this.overlayx0;
      } else {
        this.overlayX = x;
        this.overlayWidth = this.overlayx0 - x;
      }
      this.cdr.markForCheck();
      return;
    }

    if (this.activeTool === 'pan' || this.activeTool === 'move') {
      this.shiftWindow(dx);
      if (this.activeTool === 'move') {
        this.waveformContainer?.nativeElement.parentElement?.scrollBy({ top: -dy });
      }
    }
  }

  @HostListener('document:mouseup', ['$event'])
  onDocumentUp(_event: MouseEvent): void {
    if (!this.dragging) {
      return;
    }
    this.dragging = false;

    if (this.showOverlay) {
      this.showOverlay = false;
      if (this.overlayWidth > 4 && this.scalesReady) {
        const t0 = this.xScale.invert(this.overlayX);
        const t1 = this.xScale.invert(this.overlayX + this.overlayWidth);
        if (this.activeTool === 'zoomIn') {
          this.start = Math.min(t0, t1);
          this.stop = Math.max(t0, t1);
          this.clampWindow();
          void this.downloadRequiredData().then(() => this.resizePlot());
        } else if (this.activeTool === 'select') {
          this.markerTimes = [Math.min(t0, t1), Math.max(t0, t1)];
        }
      }
      this.cdr.markForCheck();
    }
  }

  waveformWheel(event: WheelEvent): void {
    if (!(this.hasData || this.hasValidData) || !this.scalesReady) {
      return;
    }
    if (this.activeTool !== 'select' && this.activeTool !== 'zoomIn' && this.activeTool !== 'zoomOut') {
      return;
    }
    event.preventDefault();
    const factor = event.deltaY > 0 ? 1.25 : 0.8;
    this.zoomAround(this.pointerX(event), factor);
  }

  timeX(time: number): number {
    return this.scalesReady ? this.xScale(time) : 0;
  }

  private pointerX(event: MouseEvent): number {
    const svg = this.waveformsvg?.nativeElement;
    if (!svg) {
      return event.offsetX;
    }
    const rect = svg.getBoundingClientRect();
    const width = rect.width || this.plotWidth || 1;
    return ((event.clientX - rect.left) / width) * this.plotWidth;
  }

  private zoomAround(pixelX: number, factor: number): void {
    const t = this.xScale.invert(pixelX);
    const range = (this.stop - this.start) * factor;
    this.start = t - range * ((t - this.start) / Math.max(this.stop - this.start, 1e-18));
    this.stop = this.start + range;
    this.clampWindow();
    void this.downloadRequiredData().then(() => this.resizePlot());
  }

  private shiftWindow(dxPixels: number): void {
    if (!this.scalesReady) {
      return;
    }
    const shift = this.xScale.invert(0) - this.xScale.invert(dxPixels);
    this.start += shift;
    this.stop += shift;
    this.clampWindow();
    void this.downloadRequiredData().then(() => this.resizePlot());
  }

  private edgesToWaveform(collection: EdgeCollection): Point[] {
    return toRawPoints(collection.firstEdgeRise, collection.edges);
  }

  private clampWindow(): void {
    const [begin, end] = this.fullDomain;
    const span = this.stop - this.start;
    if (!(end > begin) || !Number.isFinite(span)) {
      return;
    }
    if (this.start < begin) {
      this.start = begin;
      this.stop = Math.min(end, begin + span);
    }
    if (this.stop > end) {
      this.stop = end;
      this.start = Math.max(begin, end - span);
    }
    if (this.stop <= this.start) {
      this.stop = Math.min(end, this.start + this.minEdgeWidth * 40);
    }
  }

  private observeSize(): void {
    this.resizeObserver?.disconnect();
    const host = this.waveformContainer?.nativeElement ?? this.waveformsvg?.nativeElement;
    if (!host) {
      return;
    }
    this.resizeObserver = new ResizeObserver(() => {
      this.waveformSVG_Padding = this.getPadding(this.waveformsvg.nativeElement);
      this.resizePlot();
    });
    this.resizeObserver.observe(host);
  }

  private measurePlot(): void {
    const host = this.waveformContainer?.nativeElement;
    if (!host) {
      return;
    }
    this.plotWidth = Math.max(240, host.clientWidth || this.plotWidth);
    this.plotHeight = Math.max(this.minContentHeight(), host.clientHeight || this.plotHeight);
  }

  private minContentHeight(): number {
    return this.visibleTracks.length * (this.waveHeight + 4) + this.decodeHeight * 2 + this.axisHeight;
  }

  resizePlot() {
    console.log('resizePlot: entered');
    if (!this.waveformsvg?.nativeElement) {
      return;
    }
    if (!this.waveformSVG_Padding) {
      this.waveformSVG_Padding = this.getPadding(this.waveformsvg.nativeElement);
    }

    const clientRect = this.getInternalSizeExcludingPadding_SVG();
    const width = Math.max(1, clientRect.width || this.plotWidth);
    const height = Math.max(1, clientRect.height || this.plotHeight);
    this.plotWidth = width;
    this.plotHeight = height;

    this.rebuildLanes(height);

    this.xScale = d3.scaleLinear().domain([this.start, this.stop]).range([0, width]);
    this.yScale = d3.scaleLinear().domain([0, Math.max(1, this.visibleTracks.length)]).range([height, 0]);
    this.scalesReady = Number.isFinite(this.start) && Number.isFinite(this.stop) && this.stop > this.start;

    this.visibleTracks.forEach((track, index) => {
      const top = this.laneTop(index);
      const laneH = this.laneHeight(track);
      const decode = track.kind === 'bus' && this.decodeEnabled ? this.decodeGap + this.decodeHeight : 0;
      const waveTop = top + 4;
      const waveBottom = top + Math.max(12, laneH - decode - 4);
      const yScale = d3.scaleLinear().domain([-0.1, 1.1]).range([waveBottom, waveTop]);
      const channel = this.channelPaths.get(track.id);
      if (channel) {
        channel.yScale = yScale;
      }
      const bus = this.busPolygons.get(track.id);
      if (bus) {
        bus.yScale = yScale;
      }
    });

    this.updateGrid();
    if (this.edgeAvailableResponse) {
      this.updatePlot();
    }

    this.cdr.detectChanges();
    console.log('resizePlot: exited');
  }

  private rebuildLanes(plotHeight: number): void {
    if (this.channelPaths.size === 0 && this.busPolygons.size === 0) {
      this.lanes = [];
      return;
    }
    const rows: PlotTrack[] = [];
    const channels = [...this.channelPaths.entries()].sort((a, b) => a[1].index - b[1].index);
    channels.forEach(([id], index) => {
      const info = this.plotMap.get(id);
      rows.push({
        id,
        name: info?.name ?? id,
        subtitle: id === 'SCL' || id.startsWith('SDA') ? 'I3C' : 'Async',
        color: LANE_COLORS[index % LANE_COLORS.length],
        kind: 'channel'
      });
    });
    [...this.busPolygons.keys()].forEach((id, index) => {
      const info = this.plotMap.get(id);
      rows.push({
        id,
        name: info?.name ?? id,
        subtitle: 'MIL 1553',
        color: LANE_COLORS[(channels.length + index) % LANE_COLORS.length],
        kind: 'bus'
      });
    });
    const each = Math.max(plotHeight, 1) / Math.max(rows.length, 1);
    rows.forEach(row => this.laneHeights.set(row.id, each));
    this.lanes = rows;
  }

  private updateGrid(): void {
    const lineCount = 9;
    const width = Math.max(1, this.plotWidth);
    this.gridLines = this.gridEnabled
      ? Array.from({ length: lineCount }, (_, i) => {
          const x = ((i + 1) * width) / (lineCount + 1);
          const label = this.scalesReady && (this.hasData || this.hasValidData)
            ? toEngineeringTime(this.xScale.invert(x) - (this.referenceTime || this.TriggerTime || 0))
            : '';
          return { x, label };
        })
      : [];
  }

  updatePlot() {
    if (!this.edgeAvailableResponse || !this.scalesReady) {
      return;
    }

    const visibleStart = 2 * this.start - this.stop;
    const visibleStop = 2 * this.stop - this.start;

    this.channelPaths.forEach((channelPath, channel) => {
      const plotInfo = this.plotMap.get(channel);
      const waveform = plotInfo && isWaveformChannel(plotInfo.channel as number | undefined)
        ? this.waveforms.get(plotInfo.channel as CommonTypes_pb.Channels)
        : undefined;
      if (!waveform) {
        channelPath.path = '';
        return;
      }

      this.lineGenerator.x(d => this.xScale(d.x)).y(d => channelPath.yScale(d.y));
      const points = toPoints(waveform, visibleStart, visibleStop, [
        this.edgeAvailableResponse!.StartTime,
        this.edgeAvailableResponse!.EndTime
      ]);
      channelPath.path = this.lineGenerator(points) ?? '';
    });

    this.busPolygons.forEach((bus, name) => {
      const busList = this.busMap.get(name) ?? [];
      const startIndex = d3.bisectLeft(busList.map(e => e.EndTime), visibleStart);
      const endIndex = d3.bisectRight(busList.map(e => e.StartTime), visibleStop);
      const busArray = this.processBus(busList.slice(startIndex, endIndex));

      bus.polygons = busArray.map(p => ({
        center: BusExtensions.getPolygonCenter(p, this.xScale, bus.yScale),
        path: BusExtensions.getPolygon(p, this.xScale, bus.yScale),
        content: p.Content,
        styleClass: BusExtensions.getPolygonStyleName(p).replaceAll(/[ _]/g, '').toLowerCase(),
        startTime: p.StartTime,
        endTime: p.EndTime
      }));
    });

    if (this.showBits) {
      this.updateAnnotations(visibleStart, visibleStop);
    }
    queueMicrotask(() => {
      const frameIndex = this.currentFrameIndex;
      if (frameIndex == null) {
        return;
      }
      this.lastRenderedFrameIndex = frameIndex;
      this.plotRenderResolver?.(frameIndex);
    });
  }

  getInternalSizeExcludingPadding_SVG() {
    const size = this.waveformsvg.nativeElement.getBoundingClientRect();
    const padding = this.waveformSVG_Padding ?? { left: 0, right: 0, top: 0, bottom: 0 };
    return {
      left: size.left + padding.left,
      top: size.top + padding.top,
      width: size.width - padding.left - padding.right,
      height: size.height - padding.top - padding.bottom
    };
  }

  private processBus(busArray: DecoderTypes_pb.PacketBus[]) {
    const scl = this.configuration_I3C?.SCL ?? this.configuration?.SCL;
    if (scl == null) {
      return busArray;
    }
    const clkEdgeData = this.waveforms.get(scl);
    if (!clkEdgeData) {
      return busArray;
    }
    return processBusArray(busArray, clkEdgeData);
  }

  private updateAnnotations(visibleStart: number, visibleStop: number): void {
    const scl = this.configuration?.SCL ?? this.configuration_I3C?.SCL;
    const sdas = this.configuration?.SDAs ?? this.configuration_I3C?.SDAs;
    if (!this.selectedFrame || scl == null || !sdas?.length) {
      return;
    }
    let clkEdgeData = this.waveforms.get(scl);
    if (!clkEdgeData) {
      return;
    }
    const startIndex = this.bisector.left(clkEdgeData, visibleStart);
    const endIndex = this.bisector.right(clkEdgeData, visibleStop);
    clkEdgeData = clkEdgeData.slice(startIndex, endIndex);
    const dat0EdgeData = this.waveforms.get(sdas[0]);
    const positions: number[] = [];
    this.plotMap.forEach((entry, key) => {
      if (key === 'BUS') {
        return;
      }
      if (entry.selected) {
        const yScale = this.channelPaths.get(key)?.yScale;
        positions.push(yScale ? this.yScale.invert(yScale(0.5)) : Number.NaN);
      } else {
        positions.push(Number.NaN);
      }
    });
    this.annotations = annotationEx.GetBitAnnotations(
      this.selectedFrame,
      clkEdgeData,
      dat0EdgeData!,
      positions[1],
      positions[2],
      positions[3],
      positions[4]
    );
  }

  get currentFrameIndex(): number | undefined {
    return this.selectedFrame?.Index;
  }

  private capturePlot(): void {
    const svg = this.waveformsvg?.nativeElement;
    if (!svg) {
      return;
    }
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(this.plotWidth));
    clone.setAttribute('height', String(this.plotHeight));
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `
      .grid-line { stroke: #3F3F46; stroke-width: 0.5; stroke-dasharray: 3 4; }
      .lane-sep { stroke-dasharray: none; }
      .wave-path { fill: none; stroke-width: 1.5; }
      .bus-poly { fill-opacity: 0.92; stroke: rgba(255,255,255,0.35); }
      .bus-text { fill: #fff; font-size: 10px; text-anchor: middle; }
      .axis-label { fill: #A1A1AA; font-size: 10px; text-anchor: middle; }
    `;
    clone.insertBefore(style, clone.firstChild);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    bg.setAttribute('fill', '#1F1F22');
    clone.insertBefore(bg, clone.firstChild);

    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = this.plotWidth;
      canvas.height = this.plotHeight;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      canvas.toBlob(png => {
        if (!png) {
          return;
        }
        const pngUrl = URL.createObjectURL(png);
        const link = document.createElement('a');
        link.href = pngUrl;
        link.download = 'plot-view.png';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(pngUrl);
        URL.revokeObjectURL(url);
      }, 'image/png');
    };
    image.onerror = () => {
      const link = document.createElement('a');
      link.href = url;
      link.download = 'plot-view.svg';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    };
    image.src = url;
  }
}
