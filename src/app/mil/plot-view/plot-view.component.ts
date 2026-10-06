import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { PlotGrid } from './components/plot-grid/plot-grid-component';
import { MatDialog } from '@angular/material/dialog';
import * as d3 from 'd3';
import { Mutex } from 'async-mutex';
import { Subscription } from 'rxjs';
import { Point } from '../models/plot.model';
import { toPoints } from './extensions/plot-extensions';
import { BusExtensions } from './extensions/bus-extensions';
import { ImageSessionService } from './services/image-session.service';
import { D3ZoomHandler, D3ZoomHandlerCallbacks } from './services/zoom-handler';
import { ZoomStateService } from './services/zoom-state.service';

import * as WaveformTypes_pb from '../../../protos/WaveformTypes';
import * as CommonTypes_pb from '../../../protos/CommonTypes';
import { CoreService } from '../../core/services/core.services';
import * as DecoderTypes_pb from '../../../protos/DecoderTypes';
import { PlotInfoDto, ProtocolFrameDto } from '../../core/dtos/result.service.dtos';
import { HardwareStatus, HardwareStatusType } from '../../../protos/CaptureService';

export function toEngineeringTime(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs >= 1e-3) {
    return `${(seconds * 1e3).toFixed(3)} ms`;
  }
  return `${(seconds * 1e6).toFixed(3)} µs`;
}
export interface PlotTrack {
  id: string;
  name: string;
  subtitle: string;
  color: string;
  kind: 'bus' | 'channel';
}
export interface BusPolygon {
  center: Point;
  path: string;
  content: string;
  styleClass: string;
  startTime: number;
  endTime: number;
}
export interface BitLabel {
  id: string;
  x: number;
  y: number;
  text: string;
}
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
  | 'bits'
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
  subtitle: string;
  protocolName?: string;
};

type MilChannelConfig = {
  Name?: string;
  Channel?: CommonTypes_pb.Channels;
};

type MilBusConfig = {
  Name?: string;
  ProtocolName?: string;
  Channel?: CommonTypes_pb.Channels;
};

type MilRunConfig = {
  ProtocolName?: string;
  TriggerConfig?: { TriggerType?: unknown };
  Channels?: MilChannelConfig[];
  Buses?: MilBusConfig[];
  BusA?: CommonTypes_pb.Channels;
  BusB?: CommonTypes_pb.Channels;
};

declare const PubSub: {
  subscribe(topic: string, handler: (msgType: string, msg: any) => void): string;
  unsubscribe?(token: string): void;
};

@Component({
  selector: 'app-plot-view',
  standalone: true,
  imports: [CommonModule, MatIconModule, PlotGrid],
  templateUrl: './plot-view.component.html',
  styleUrl: './plot-view.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PlotViewComponent implements AfterViewInit, OnDestroy, OnChanges {
  @ViewChild('plotCapture') plotCapture?: ElementRef<HTMLElement>;
  @ViewChild('waveformContainer') waveformContainer?: ElementRef<HTMLElement>;
  @ViewChild('waveformsvg', { static: true }) waveformsvg!: ElementRef<SVGElement>;
  private waveformSVG_Padding!: Padding;
  private pubSubTokens: string[] = [];

  getLegendDisplayName(plot: string) {
    return this.plotMap.get(plot)?.name ?? plot;
  }
  triggerFound = false;
  hasValidData = false;
  xScale!: d3.ScaleLinear<number, number>;
  yScale!: d3.ScaleLinear<number, number>;
  private scalesReady = false;
  showBits = false;
  bitLabels: BitLabel[] = [];

  readonly tracks: PlotTrack[] = [
    { id: 'busA', name: 'Bus A', subtitle: 'MIL 1553', color: '#5B9BD5', kind: 'bus' },
    { id: 'busB', name: 'Bus B', subtitle: 'MIL 1553', color: '#E77352', kind: 'bus' },
    { id: 'ch1', name: 'Channel 1', subtitle: 'Async', color: '#F5C518', kind: 'channel' },
    { id: 'ch2', name: 'Channel 2', subtitle: 'Async', color: '#C084FC', kind: 'channel' },
    { id: 'ch3', name: 'Channel 3', subtitle: 'Async', color: '#F472B6', kind: 'channel' },
    { id: 'ch4', name: 'Channel 4', subtitle: 'Async', color: '#4ADE80', kind: 'channel' }
  ];

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
    { id: 'fit', icon: 'calendar_month', label: 'Fit', order: 7 },
    { id: 'grid', icon: 'grid_3x3', label: 'Grid', order: 8 },
    { id: 'bits', icon: 'table_chart', label: 'Bits', order: 9 }
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

  private downloadedDataStart?: number;
  private downloadedDataStop?: number;
  private minEdgeWidthIsFinal = false;
  private configuration?: MilRunConfig;
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

  @Input() set TriggerTime(time: number) {
    this.triggerTime = time;
  }

  get TriggerTime(): number {
    return this.triggerTime;
  }

  hideControls = false;
  private fontsLoaded = false;
  private imageCaptureSub?: Subscription;
  private readonly dialog = inject(MatDialog, { optional: true });
  private readonly imageSession = inject(ImageSessionService, { optional: true });
  private readonly zoomStateService = inject(ZoomStateService, { optional: true });

  constructor(
    private cdr: ChangeDetectorRef,
    private coreService: CoreService
  ) {}

  public waitUntilPlotReady(expectedFrame: number): Promise<boolean> {
    return new Promise(resolve => {
      if (this.lastRenderedFrameIndex === expectedFrame) {
        resolve(true);
        return;
      }

      let finished = false;
      this.plotRenderResolver = (renderedFrame) => {
        if (renderedFrame === expectedFrame && !finished) {
          finished = true;
          this.plotRenderResolver = undefined;
          resolve(true);
        }
      };
    });
  }

  get visibleTracks(): PlotTrack[] {
    return this.lanes.length ? this.lanes : this.tracks;
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
        this.referenceTime = msg.ReferenceStartTime;
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
          this.configuration = await this.coreService.AppConfigService.getConfig() as MilRunConfig;

          console.log('PlotViewComponent:', this.configuration);

          this.triggerEnabled = !!this.configuration?.TriggerConfig?.TriggerType;
          this.applyMilConfiguration();

          console.log('Plot map', this.plotMap);

          if (this.edgeAvailableResponse) {
            await this.updatePlotLimits();
          }
          this.resizePlot();
          break;
        }

        case CommonTypes_pb.SystemStates.CleanupRun:
        case CommonTypes_pb.SystemStates.Ready:
          await this.cleanWaveformData();
          this.edgeAvailableResponse = undefined;
          this.hasValidData = false;
          this.hasData = false;
          this.lanes = [];
          this.triggerEnabled = false;
          this.triggerFound = false;
          this.triggerTime = 0;
          this.resizePlot();
          break;
      }
    }));

    try {
      this.imageCaptureSub = this.imageSession?.captureRequest$.subscribe(
        async ({ frameIndex, resolve }) => {
          await this.waitUntilPlotReady(frameIndex);
          await new Promise(r => requestAnimationFrame(() => r(null)));
          await new Promise(r => setTimeout(r, 30));
          const img = await this.CapturePlotImage();
          resolve(img);
        });
    } catch (err) {
      console.error('Image capture subscription failed:', err);
    }
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

  private applyMilConfiguration(): void {
    if (!this.configuration) {
      return;
    }
    this.addMilWaveformLanes(this.configuration);
    this.addDecodeLanes(this.configuration);
  }

  private addMilWaveformLanes(config: MilRunConfig): void {
    const lanes: { name: string; channel: CommonTypes_pb.Channels; subtitle: string; allowSelection: boolean }[] = [];
    if (config.BusA != null) {
      lanes.push({ name: 'Bus A', channel: config.BusA, subtitle: 'MIL 1553', allowSelection: false });
    }
    if (config.BusB != null) {
      lanes.push({ name: 'Bus B', channel: config.BusB, subtitle: 'MIL 1553', allowSelection: false });
    }
    (config.Buses ?? []).forEach((bus, index) => {
      if (bus.Channel == null) {
        return;
      }
      lanes.push({
        name: bus.Name?.trim() || `Bus ${String.fromCharCode(65 + index)}`,
        channel: bus.Channel,
        subtitle: 'MIL 1553',
        allowSelection: false
      });
    });
    (config.Channels ?? []).forEach((channel, index) => {
      if (channel?.Channel == null) {
        return;
      }
      lanes.push({
        name: channel.Name?.trim() || `Channel ${index + 1}`,
        channel: channel.Channel,
        subtitle: 'Async',
        allowSelection: true
      });
    });

    lanes.forEach(lane => {
      const channelId = lane.channel as unknown as number;
      const existingKey = this.keyForChannel(channelId);
      if (existingKey) {
        const entry = this.plotMap.get(existingKey)!;
        entry.name = lane.name;
        entry.subtitle = lane.subtitle;
        entry.allowSelection = lane.allowSelection;
        return;
      }
      this.plotMap.set('CH' + channelId, {
        name: lane.name,
        channel: lane.channel,
        allowSelection: lane.allowSelection,
        selected: true,
        subtitle: lane.subtitle
      });
    });
  }

  private addDecodeLanes(config: MilRunConfig): void {
    const buses = config.Buses?.length
      ? config.Buses.map((bus, index) => ({
          name: bus.Name?.trim() || `Bus ${String.fromCharCode(65 + index)}`,
          protocolName: bus.ProtocolName || config.ProtocolName
        }))
      : config.ProtocolName
        ? [{ name: config.ProtocolName, protocolName: config.ProtocolName }]
        : [];

    const usedProtocols = new Set<string>();
    this.plotMap.forEach(entry => {
      if (entry.channel == null && entry.protocolName) {
        usedProtocols.add(entry.protocolName);
      }
    });

    buses.forEach((bus, index) => {
      if (!bus.protocolName || usedProtocols.has(bus.protocolName)) {
        return;
      }
      const key = 'BUS' + index;
      const existing = this.plotMap.get(key);
      if (existing && existing.channel == null) {
        existing.name = bus.name;
        existing.protocolName = bus.protocolName;
        existing.subtitle = 'MIL 1553';
      } else {
        this.plotMap.set(key, {
          name: bus.name,
          allowSelection: false,
          selected: true,
          subtitle: 'MIL 1553',
          protocolName: bus.protocolName
        });
      }
      usedProtocols.add(bus.protocolName);
    });
  }

  private keyForChannel(channelId: number): string | undefined {
    for (const [key, entry] of this.plotMap) {
      if (entry.channel != null && (entry.channel as unknown as number) === channelId) {
        return key;
      }
    }
    return undefined;
  }

  private ensurePlotMapFromEdges(): void {
    if (!this.edgeAvailableResponse) {
      return;
    }
    const known = new Set<number>();
    this.plotMap.forEach(entry => {
      if (entry.channel != null) {
        known.add(entry.channel as unknown as number);
      }
    });
    this.edgeAvailableResponse.ChannelEdgeAvailable.forEach(channel => {
      const id = channel.Channel as unknown as number;
      if (id == null || known.has(id)) {
        return;
      }
      this.plotMap.set('CH' + id, {
        name: 'Channel ' + (known.size + 1),
        channel: channel.Channel,
        allowSelection: true,
        selected: true,
        subtitle: 'Async'
      });
      known.add(id);
    });
    if (this.configuration) {
      this.addDecodeLanes(this.configuration);
    }
  }

  private seedSeriesFromPlotMap(): void {
    let index = 1;
    this.plotMap.forEach((entry, key) => {
      if (!entry.selected) {
        return;
      }
      if (entry.channel != null) {
        if (!this.waveforms.has(entry.channel)) {
          this.waveforms.set(entry.channel, []);
        }
        const existing = this.channelPaths.get(key);
        if (existing) {
          existing.index = index++;
        } else {
          this.channelPaths.set(key, { index: index++, channel: entry.channel, yScale: d3.scaleLinear(), path: '' });
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

  private async updatePlotLimits() {
    console.log('edges came');
    if (!(this.edgeAvailableResponse && this.edgeAvailableResponse.ChannelEdgeAvailable.length > 0)) {
      return;
    }

    this.ensurePlotMapFromEdges();
    if (this.plotMap.size == 0) {
      return;
    }
    this.seedSeriesFromPlotMap();
    console.log('update limits plots added', this.plotMap);

    var dataStart = this.edgeAvailableResponse.StartTime;
    var dataEnd = this.edgeAvailableResponse.EndTime;
    this.fullDomain = [dataStart, dataEnd > dataStart ? dataEnd : dataStart + this.minEdgeWidth * 1000];

    if ((this.downloadedDataStart == undefined && this.downloadedDataStop == undefined) ||
      (this.minEdgeWidthIsFinal == false)) {

      var channelWithMoreEdges = this.edgeAvailableResponse
        .ChannelEdgeAvailable
        .reduce((max, current) =>
          current.Count > max.Count ? current : max
        );

      var edgeCount = channelWithMoreEdges.Count;

      if (edgeCount > 1000) {
        edgeCount = 1000;
        this.minEdgeWidthIsFinal = true;
      }

      let minEdgeWidth: number | undefined;
      let maxEdgeWidth: number | undefined;
      try {
        var response = await this.coreService.ResultService.getEdges({ Channel: channelWithMoreEdges.Channel, IndexBased: { Offset: 0, Count: edgeCount } });
        var edgeList = response?.Edges?.Edges ?? [];
        var difference = edgeList
          .map((d: number, i: number, arr: number[]) => (i > 0 ? d - arr[i - 1] : null))
          .slice(1);
        [minEdgeWidth, maxEdgeWidth] = d3.extent(difference.filter((v): v is number => v != null && v > 0));
        if (typeof minEdgeWidth === 'number' && minEdgeWidth > 0) {
          this.minEdgeWidth = minEdgeWidth;
        }
        console.log('update min/ max edges', minEdgeWidth, maxEdgeWidth, this.start, this.stop, 'channel', channelWithMoreEdges.Channel, 'firstedge', response?.Edges?.FirstEdge);
      } catch (error) {
        console.error('min edge sample failed', error);
      }

      if ((this.downloadedDataStart === undefined && this.downloadedDataStop === undefined)) {
        this.start = dataStart;
        this.stop = dataStart + this.minEdgeWidth * 1000;
      }

      let downloadedStart = this.downloadedDataStart;
      let downloadedStop = this.downloadedDataStop;

      try {
        await this.downloadRequiredData();
      } catch (error) {
        console.error('downloadRequiredData failed', error);
      }

      const hasPoints = [...this.waveforms.values()].some(points => points.length > 0)
        || [...this.busMap.values()].some(packets => packets.length > 0);
      if (this.downloadedDataStart === downloadedStart && this.downloadedDataStop === downloadedStop && !hasPoints) {
        return;
      }

      if (hasPoints) {
        this.hasValidData = true;
        this.hasData = true;
        this.resizePlot();
      }
    }
  }

  private async downloadRequiredData() {
    const release = await mutex.acquire();
    try {
      console.log('downloadRequiredData: entered');
      if (!this.edgeAvailableResponse) {
        return;
      }

      var visibleRange = this.stop - this.start;
      let cacheStartTime = this.start - 4 * visibleRange;
      let cacheStopTime = this.stop + 4 * visibleRange;

      if (this.edgeAvailableResponse.StartTime > cacheStartTime) {
        cacheStartTime = this.edgeAvailableResponse.StartTime;
      }
      if (this.edgeAvailableResponse.EndTime < cacheStopTime) {
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
        const protocolName = this.plotMap.get(busMapItem[0])?.protocolName;
        if (!protocolName) {
          continue;
        }
        let busResponseData: DecoderTypes_pb.PacketBus[] = [];
        try {
          busResponseData = await this.requestBus(protocolName, startTime, stopTime);
        } catch (error) {
          console.error('requestBus failed', busInfo.name, error);
        }
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

      for (var busMapItem of this.busMap) {
        var bus = busMapItem[1];
        var protocolName = this.plotMap.get(busMapItem[0])?.protocolName;
        if (!protocolName) {
          continue;
        }

        let busResponseData: DecoderTypes_pb.PacketBus[] = [];
        try {
          busResponseData = await this.requestBus(protocolName, startTime, stopTime);
        } catch (error) {
          console.error('requestBus failed', protocolName, error);
        }

        let appendedBus: DecoderTypes_pb.PacketBus[] = bus;
        if (bus.length > 0) {
          if (busResponseData.length > 0) {
            var busIndex = this.busBisectorLeft(bus, busResponseData[0].StartTime);
            appendedBus = bus.slice(0, busIndex).concat(busResponseData);
          }
        } else {
          appendedBus = busResponseData;
        }
        this.busMap.set(busMapItem[0], appendedBus);
        console.log('appendWaveformRequest: bus updated', appendedBus);
      }
    }
    this.downloadedDataStop = stopTime;
  }

  private async requestBus(name: string, startTime: number, stopTime: number) {
    const busResponse = await this.coreService.ResultService.getBus({ ProtocolName: name, StartTime: startTime, EndTime: stopTime });
    return busResponse!.Buses.sort((a, b) => a.StartTime - b.EndTime);
  }

  async requestData(startTime: number, stopTime: number) {
    const edgesMap: Map<CommonTypes_pb.Channels, WaveformTypes_pb.EdgeCollection> = new Map();

    for (const channel of this.waveforms.keys()) {
      try {
        const edgeResponse = await this.coreService.ResultService.getEdges({
          Channel: channel,
          TimeBased: { StartTime: startTime, EndTime: stopTime }
        });
        if (edgeResponse?.Edges) {
          edgesMap.set(channel, edgeResponse.Edges);
        }
      } catch (error) {
        console.error('getEdges failed', channel, error);
      }
    }

    return edgesMap;
  }

  private toRawPoints(firstEdge: boolean, edges: number[]) {
    var points: Point[] = [];
    for (let index = 0; index < edges.length; index++) {
      points.push({ x: edges[index], y: this.getWaveformState(firstEdge, index) });
    }

    return points;
  }

  private getWaveformState(firstEdge: boolean, index: number) {
    return index % 2 == (firstEdge ? 0 : 1) ? 1 : 0;
  }

  ngOnDestroy(): void {
    this.zoomHandler?.destroy();
    this.imageCaptureSub?.unsubscribe();
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
    if (tool === 'bits' || tool === 'flag') {
      return this.showBits;
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
      case 'bits':
      case 'flag':
        this.showBits = !this.showBits;
        this.updatePlot();
        break;
      case 'cursor':
        this.disableEvents();
        this.activeTool = 'cursor';
        this.cursorEnabled = true;
        break;
      case 'select':
        this.activeTool = 'select';
        this.selectEnabled = true;
        this.cursorEnabled = false;
        this.setupZoom();
        break;
      case 'zoomIn':
        this.disableEvents();
        this.activeTool = 'zoomIn';
        this.zoomInEnabled = true;
        this.selectEnabled = false;
        this.cursorEnabled = false;
        break;
      case 'zoomOut':
        this.disableEvents();
        this.activeTool = 'zoomOut';
        this.zoomOutEnabled = true;
        this.selectEnabled = false;
        this.cursorEnabled = false;
        break;
      case 'pan':
        this.activeTool = 'pan';
        this.selectEnabled = false;
        this.cursorEnabled = false;
        this.setupZoom();
        break;
      case 'move':
        this.activeTool = 'move';
        this.selectEnabled = false;
        this.cursorEnabled = false;
        this.setupZoom();
        break;
      case 'fit':
        this.onFitClick(event);
        break;
    }
    this.cdr.markForCheck();
  }

  private zoomHandler?: D3ZoomHandler;
  private zoomInEnabled = false;
  private zoomOutEnabled = false;

  private disableEvents(): void {
    this.zoomHandler?.destroy();
    this.zoomHandler = undefined;

    d3.select(this.waveformsvg.nativeElement).select('g.zoom-content').attr('transform', null);

    this.showOverlay = false;
    this.zoomInEnabled = false;
    this.zoomOutEnabled = false;
    this.cdr.detectChanges();
  }

  private setupZoom(): void {
    if (!this.waveformsvg?.nativeElement) {
      return;
    }
    this.disableEvents();

    const zoomCallbacks: D3ZoomHandlerCallbacks = {
      onTransform: (transform) => {
        d3.select(this.waveformsvg.nativeElement)
          .select('g.zoom-content')
          .attr('transform', `translate(${transform.x},0) scale(${transform.k},1)`);

        this.zoomStateService?.updateTransform(transform);
      },
      onTransformEnd: async (finalTransform) => {
        if (!this.scalesReady) {
          this.zoomHandler?.reset();
          d3.select(this.waveformsvg.nativeElement).select('g.zoom-content').attr('transform', null);
          return;
        }
        const newDomain = finalTransform.rescaleX(this.xScale).domain() as [number, number];
        console.log('Interaction ended. New domain:', newDomain);
        await this.processDomainUpdate(newDomain);
        this.zoomStateService?.updateTransform(d3.zoomIdentity);
      }
    };

    this.zoomHandler = new D3ZoomHandler(
      this.waveformsvg.nativeElement,
      zoomCallbacks,
      { scaleExtent: [0.1, 10] }
    );
    this.zoomHandler.init();
  }

  private async processDomainUpdate(domain: [number, number]): Promise<void> {
    this.start = domain[0];
    this.stop = domain[1];
    this.clampWindow();
    await this.downloadRequiredData();
    this.resizePlot();
    this.zoomHandler?.reset();
    d3.select(this.waveformsvg.nativeElement).select('g.zoom-content').attr('transform', null);
    console.log('Chart updated and zoom state has been reset.');
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
    this.onMouseEnableClick(event);
    this.activeTool = 'pan';
    this.selectEnabled = false;
    this.cdr.markForCheck();
  }

  onFitClick(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (this.selectedFrame) {
      void this.GotoTime(this.selectedFrame.StartTime, this.selectedFrame.EndTime);
    }
  }

  onCursorEnableClick(_model: unknown, event?: Event): void {
    this.onTool('cursor', event);
  }

  onEnableGrid(event: Event): void {
    this.onTool('grid', event);
  }

  onBitsClick(event: Event): void {
    this.onTool('bits', event);
  }

  SaveImage(): void {
    if (!this.dialog) {
      console.error('Save image dialog is not available');
      return;
    }
    void import('./components/save-image/save-image.component')
      .then(({ SaveImageComponent }) => {
        const dialogRef = this.dialog!.open(SaveImageComponent);
        dialogRef.afterClosed().subscribe((result: { filePath: string; fileName: string }) => {
          if (result?.filePath && result?.fileName) {
            void this.capturePlot(result.filePath, result.fileName);
          }
        });
      })
      .catch(err => console.error('Save image dialog failed to load:', err));
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

    if (this.zoomInEnabled) {
      this.dragging = true;
      this.showOverlay = true;
      this.overlayx0 = x;
      this.overlayX = x;
      this.overlayWidth = 0;
      event.preventDefault();
      return;
    }

    if (this.zoomOutEnabled) {
      const visibleRange = this.stop - this.start;
      const position = this.xScale.invert(x);
      this.start = position - 2 * visibleRange;
      this.stop = position + 2 * visibleRange;
      this.clampWindow();
      void this.downloadRequiredData().then(() => this.resizePlot());
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

    if ((this.activeTool === 'select' || this.activeTool === 'pan' || this.activeTool === 'move') && this.zoomHandler) {
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

    if (this.activeTool === 'pan') {
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

    if (this.showOverlay && this.zoomInEnabled) {
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

    if (this.activeTool === 'move') {
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
      if (this.overlayWidth > 2 && this.scalesReady && this.zoomInEnabled) {
        this.start = this.xScale.invert(this.overlayX);
        this.stop = this.xScale.invert(this.overlayX + this.overlayWidth);
        this.clampWindow();
        this.resizePlot();
      }
      this.cdr.markForCheck();
    }
  }

  waveformWheel(event: WheelEvent): void {
    if (this.zoomHandler || this.zoomInEnabled || this.zoomOutEnabled) {
      return;
    }
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

    const waveformCount = [...this.plotMap.values()].filter(entry => entry.selected && entry.channel != null).length;
    const decodeCount = this.busPolygons.size;
    const slots = Math.max(1, waveformCount + decodeCount);

    var clientRect = this.getInternalSizeExcludingPadding_SVG();
    const width = Math.max(1, clientRect.width || this.plotWidth);
    const height = Math.max(this.minContentHeight(), clientRect.height || this.plotHeight);
    this.plotWidth = width;
    this.plotHeight = height;

    const slot = height / slots;

    const orderedChannels = [...this.channelPaths.entries()]
      .sort((a, b) => a[1].index - b[1].index);

    orderedChannels.forEach(([, v], i) => {
      v.yScale = d3.scaleLinear()
        .domain([-0.1, 1.1])
        .range([(i + 1) * slot, i * slot]);
    });

    [...this.busPolygons.entries()]
      .sort((a, b) => a[1].index - b[1].index)
      .forEach(([, v], i) => {
        const lane = waveformCount + i;
        v.yScale = d3.scaleLinear().domain([-0.1, 1.1]).range([(lane + 1) * slot, lane * slot]);
      });

    this.xScale = d3.scaleLinear()
      .domain([this.start, this.stop])
      .range([0, width]);

    this.yScale = d3.scaleLinear()
      .domain([0, Math.max(1, waveformCount)])
      .range([Math.max(slot, waveformCount * slot), 0]);

    this.rebuildLanes(slot, slot);
    this.scalesReady = Number.isFinite(this.start) && Number.isFinite(this.stop) && this.stop > this.start;
    this.updateGrid();
    d3.select(this.waveformsvg.nativeElement).select('g.zoom-content').attr('transform', null);

    if (this.edgeAvailableResponse)
      this.updatePlot();

    this.cdr.detectChanges();
    console.log('resizePlot: exited');
  }

  private rebuildLanes(channelHeight: number, busHeight: number): void {
    if (this.channelPaths.size === 0 && this.busPolygons.size === 0) {
      return;
    }
    const rows: PlotTrack[] = [];
    const channels = [...this.channelPaths.entries()].sort((a, b) => a[1].index - b[1].index);
    channels.forEach(([id], index) => {
      const info = this.plotMap.get(id);
      rows.push({
        id,
        name: info?.name ?? id,
        subtitle: info?.subtitle ?? 'Async',
        color: LANE_COLORS[index % LANE_COLORS.length],
        kind: 'channel'
      });
      this.laneHeights.set(id, channelHeight);
    });
    [...this.busPolygons.keys()].forEach((id, index) => {
      const info = this.plotMap.get(id);
      rows.push({
        id,
        name: info?.name ?? id,
        subtitle: info?.subtitle ?? 'MIL 1553',
        color: LANE_COLORS[(channels.length + index) % LANE_COLORS.length],
        kind: 'bus'
      });
      this.laneHeights.set(id, Math.max(busHeight, 1));
    });
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
    if (!this.edgeAvailableResponse) return;

    const visibleStart = 2 * this.start - this.stop;
    const visibleStop = 2 * this.stop - this.start;

    this.channelPaths.forEach((v, channel) => {
      const channelPath = this.channelPaths.get(channel)!;
      const plotInfo = this.plotMap.get(channel);

      if (plotInfo?.channel != null) {
        const waveform = this.waveforms.get(plotInfo.channel);
        if (!waveform) {
          channelPath.path = '';
          return;
        }

        this.lineGenerator
          .x(d => this.xScale(d.x))
          .y(d => v.yScale(d.y));

        const points = toPoints(
          waveform,
          visibleStart,
          visibleStop,
          [
            this.edgeAvailableResponse!.StartTime,
            this.edgeAvailableResponse!.EndTime
          ]
        );

        channelPath.path = this.lineGenerator(points) ?? '';
      }
    });

    this.bitLabels = this.showBits ? this.buildBitLabels() : [];

    this.busPolygons.forEach((bus, name) => {
      const busList = this.busMap.get(name) ?? [];
      const startIndex = d3.bisectLeft(busList.map(e => e.EndTime), visibleStart);
      const endIndex = d3.bisectRight(busList.map(e => e.StartTime), visibleStop);
      const busArray = busList.slice(startIndex, endIndex);

      bus.polygons = busArray.map(p => ({
        center: BusExtensions.getPolygonCenter(p, this.xScale, bus.yScale),
        path: BusExtensions.getPolygon(p, this.xScale, bus.yScale),
        content: p.Content,
        styleClass: BusExtensions.getPolygonStyleName(p).replaceAll(/[ _]/g, '').toLowerCase(),
        startTime: p.StartTime,
        endTime: p.EndTime
      }));
    });

    queueMicrotask(() => {
      const frameIndex = this.currentFrameIndex;
      if (frameIndex == null) {
        return;
      }
      this.lastRenderedFrameIndex = frameIndex;
      this.plotRenderResolver?.(frameIndex);
    });
  }

  private buildBitLabels(): BitLabel[] {
    if (!this.scalesReady || !this.edgeAvailableResponse) {
      return [];
    }

    const labels: BitLabel[] = [];
    const visibleStart = this.start;
    const visibleStop = this.stop;
    const domain: [number, number] = [
      this.edgeAvailableResponse.StartTime,
      this.edgeAvailableResponse.EndTime
    ];

    this.channelPaths.forEach((channel, id) => {
      const plotInfo = this.plotMap.get(id);
      if (plotInfo?.channel == null) {
        return;
      }
      const waveform = this.waveforms.get(plotInfo.channel);
      if (!waveform?.length) {
        return;
      }

      const points = toPoints(waveform, visibleStart, visibleStop, domain);
      for (let i = 0; i < points.length - 1; i++) {
        const start = points[i];
        const end = points[i + 1];
        if (start.y !== end.y) {
          continue;
        }
        const x1 = this.xScale(start.x);
        const x2 = this.xScale(end.x);
        if (x2 - x1 < 12) {
          continue;
        }
        const high = start.y >= 0.5;
        labels.push({
          id: `${id}-${i}`,
          x: (x1 + x2) / 2,
          y: channel.yScale(start.y) + (high ? 11 : -4),
          text: high ? '1' : '0'
        });
      }
    });

    return labels;
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

  get currentFrameIndex(): number | undefined {
    return this.selectedFrame?.Index;
  }

  private async rasterizePlot(element: HTMLElement): Promise<string | undefined> {
    const html2canvas = (await import('html2canvas')).default;
    const canvas = await html2canvas(element, {
      backgroundColor: '#1f1f22',
      scale: 2,
      removeContainer: true,
      useCORS: true
    });
    return canvas.toDataURL('image/png').split(',')[1];
  }

  async capturePlot(filePath: string, fileName: string) {
    this.hideControls = true;
    this.cdr.detectChanges();
    try {
      await document.fonts.ready;
      const element = this.plotCapture?.nativeElement ?? this.waveformContainer?.nativeElement;
      if (!element) {
        return;
      }
      const imageBase64 = await this.rasterizePlot(element);
      if (!imageBase64) {
        return;
      }

      this.hideControls = false;
      this.cdr.detectChanges();
      const fullPath = `${filePath}/${fileName}`;
      const response = await this.coreService.FileService.FileSave({
        Filename: fullPath,
        Content: imageBase64,
        IsBinary: true
      });
      if (response.Success) {
        console.log('Plot Image saved at:', fullPath);
        this.imageSession?.addImage({
          imagePath: fullPath,
          isIncluded: true,
          description: ''
        });
        const readFileResponse = await this.coreService.FileService.ReadFile({
          Filename: fullPath,
          IsBinary: true
        });
        if (readFileResponse.Success === true) {
          this.imageSession?.updateImageBase64(fullPath, readFileResponse.Content);
        } else {
          console.error(readFileResponse.Error);
          return;
        }
      } else {
        console.error('File save failed');
      }
    } catch (err) {
      console.error('Failed to capture or save image:', err);
    } finally {
      this.hideControls = false;
      this.cdr.detectChanges();
    }
  }

  async CapturePlotImage(): Promise<string | undefined> {
    try {
      this.hideControls = true;
      this.cdr.detectChanges();

      if (!this.fontsLoaded) {
        await document.fonts.ready;
        this.fontsLoaded = true;
      }

      const element = this.plotCapture?.nativeElement ?? this.waveformContainer?.nativeElement;
      if (!element) {
        return undefined;
      }

      const canvas = await this.rasterizePlot(element);
      return canvas;
    } catch (err) {
      console.error('CapturePlotImage error:', err);
      return undefined;
    } finally {
      this.hideControls = false;
      this.cdr.detectChanges();
    }
  }
}
