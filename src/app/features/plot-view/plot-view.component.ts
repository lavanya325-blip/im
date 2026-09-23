import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  HostListener,
  Input,
  OnDestroy,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import * as d3 from 'd3';
import { BusPolygon, PacketBus, PlotTrack, Point } from './models/plot-track.model';
import { EdgeCollection, TraceData } from './models/trace-data.model';
import { toEngineeringTime, toPoints, toRawPoints } from './extensions/plot-extensions';
import { BusExtensions } from './extensions/bus-extensions';

const EPS = 1e-12;
/** Visible plot should not be less than 1 ns (same floor as I3C). */
const MIN_VISIBLE_SPAN = 1e-9;

@Component({
  selector: 'app-plot-view',
  standalone: true,
  imports: [CommonModule, MatIconModule],
  templateUrl: './plot-view.component.html',
  styleUrl: './plot-view.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PlotViewComponent implements AfterViewInit, OnDestroy {
  @ViewChild('waveformContainer') waveformContainer?: ElementRef<HTMLElement>;
  @ViewChild('waveformsvg') waveformsvg?: ElementRef<SVGSVGElement>;

  /** Bind capture data from the backend / imported trace. Empty until then. */
  @Input()
  set capture(value: TraceData | null | undefined) {
    this.loadTrace(value ?? null);
  }

  /** File chosen by Import. Parsing it fills the lanes. */
  @Input()
  set traceFile(file: File | Blob | null | undefined) {
    if (file) {
      void this.loadTraceFile(file);
    }
  }

  readonly tracks: PlotTrack[] = [
    { id: 'busA', name: 'Bus A', subtitle: 'MIL 1553', color: '#5B9BD5', kind: 'bus' },
    { id: 'busB', name: 'Bus B', subtitle: 'MIL 1553', color: '#E77352', kind: 'bus' },
    { id: 'ch1', name: 'Channel 1', subtitle: 'Async', color: '#F5C518', kind: 'channel' },
    { id: 'ch2', name: 'Channel 2', subtitle: 'Async', color: '#C084FC', kind: 'channel' },
    { id: 'ch3', name: 'Channel 3', subtitle: 'Async', color: '#F472B6', kind: 'channel' },
    { id: 'ch4', name: 'Channel 4', subtitle: 'Async', color: '#4ADE80', kind: 'channel' }
  ];

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
  /** Kept for older templates that still bind cursorX / markers / flags. */
  flags: number[] = [];

  showOverlay = false;
  overlayX = 0;
  overlayWidth = 0;
  private overlayx0 = 0;
  private dragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

  plotWidth = 800;
  plotHeight = 520;
  readonly axisHeight = 24;
  /** Compact square-wave amplitude — leftover height becomes gap under each lane. */
  readonly waveHeight = 52;
  readonly decodeGap = 4;
  laneGap = 8;
  /** Figma Group 9: 19px decode strip directly under the bus wave. */
  readonly decodeHeight = 19;

  xScale!: d3.ScaleLinear<number, number>;
  wavePaths = new Map<string, string>();
  busPolygons = new Map<string, BusPolygon[]>();
  gridLines: { x: number; label: string }[] = [];

  private waveforms = new Map<string, Point[]>();
  private busMap = new Map<string, PacketBus[]>();
  private fullDomain: [number, number] = [0, 1];
  private start = 0;
  private stop = 1;
  private minEdgeWidth = 50e-9;
  private referenceTime = 0;
  private resizeObserver?: ResizeObserver;
  private zoomBehavior?: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private viewReady = false;
  private pubsubTokens: Array<string | number> = [];
  private loadedTrace: TraceData | null = null;
  private readonly lineGenerator = d3.line<Point>().curve(d3.curveStepAfter);
  private readonly busBisectorLeft = d3.bisector((d: PacketBus) => d.EndTime).left;
  private readonly busBisectorRight = d3.bisector((d: PacketBus) => d.StartTime).right;

  constructor(private cdr: ChangeDetectorRef) {
    this.bindTraceFileEvents();
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.observeSize();
    this.measurePlot();
    this.resizePlot();
    this.setupZoom();
  }

  ngOnDestroy(): void {
    this.disableEvents();
    this.resizeObserver?.disconnect();
    const pubsub = (globalThis as { PubSub?: { unsubscribe: (token: string | number) => void } }).PubSub;
    this.pubsubTokens.forEach(token => pubsub?.unsubscribe(token));
    this.pubsubTokens = [];
  }

  /**
   * Import publishes the trace after the file is read. Same payload as [capture] / loadTraceFile.
   */
  @HostListener('document:tracefile-loaded', ['$event'])
  @HostListener('document:mil-trace-loaded', ['$event'])
  onTraceFileLoaded(event: Event): void {
    void this.ingestLoadedTrace((event as CustomEvent).detail);
  }

  trackTrack(_index: number, track: PlotTrack): string {
    return track.id;
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
    const decode = track.kind === 'bus' && this.decodeEnabled ? this.decodeGap + this.decodeHeight : 0;
    return this.waveHeight + decode + this.laneGap;
  }

  laneTop(trackIndex: number): number {
    let top = 0;
    for (let i = 0; i < trackIndex; i++) {
      top += this.laneHeight(this.tracks[i]);
    }
    return top;
  }

  contentHeight(): number {
    return this.laneTop(this.tracks.length) + this.axisHeight;
  }

  decodeTop(trackIndex: number): number {
    return this.laneTop(trackIndex) + this.waveHeight + this.decodeGap;
  }

  /**
   * Single entry for plot data. Map a loaded .trace / ResultService
   * response into TraceData and call this. Lanes stay empty until a trace arrives.
   */
  loadTrace(data: TraceData | null): void {
    this.clearPlot();
    this.loadedTrace = null;

    if (!data) {
      this.hasData = false;
      this.paint();
      return;
    }

    const aligned = alignTraceToTracks(data, this.tracks.map(track => track.id));
    this.loadedTrace = aligned;
    this.minEdgeWidth = aligned.minEdgeWidth > 0 ? aligned.minEdgeWidth : MIN_VISIBLE_SPAN;
    this.referenceTime = Number.isFinite(aligned.referenceTime) ? aligned.referenceTime : aligned.startTime;
    const end = aligned.endTime > aligned.startTime ? aligned.endTime : aligned.startTime + this.minEdgeWidth * 1000;
    this.fullDomain = [aligned.startTime, end];

    Object.entries(aligned.channels).forEach(([id, collection]) => {
      if (!collection.edges.length) {
        return;
      }
      this.waveforms.set(id, this.edgesToWaveform(collection));
    });
    Object.entries(aligned.buses).forEach(([id, packets]) => {
      if (!packets.length) {
        return;
      }
      this.busMap.set(id, [...packets].sort((a, b) => a.StartTime - b.StartTime));
    });

    this.applyInitialWindow();
    this.hasData = this.waveforms.size > 0 || this.busMap.size > 0;
    this.paint();
  }

  /** Read a trace file and draw it. Called from Import or [traceFile]. */
  async loadTraceFile(file: File | Blob): Promise<void> {
    const text = await file.text();
    this.loadTrace(parseTraceText(text));
  }

  get hasValidData(): boolean {
    return this.hasData;
  }

  get cursorX(): number {
    if (!this.xScale || this.cursorTimes.length === 0) {
      return -1;
    }
    return this.xScale(this.cursorTimes[this.cursorTimes.length - 1]);
  }

  get markers(): number[] {
    if (!this.xScale) {
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
        this.measurePlot();
        this.resizePlot();
        break;
      case 'cursor':
        this.activeTool = 'cursor';
        this.cursorEnabled = true;
        this.selectEnabled = false;
        this.disableEvents();
        break;
      case 'select':
        this.activeTool = 'select';
        this.selectEnabled = true;
        this.cursorEnabled = false;
        this.setupZoom();
        break;
      case 'pan':
        this.activeTool = tool;
        this.selectEnabled = false;
        this.cursorEnabled = false;
        this.setupZoom();
        break;
      case 'zoomIn':
      case 'zoomOut':
      case 'move':
        this.activeTool = tool;
        this.selectEnabled = false;
        this.cursorEnabled = false;
        this.disableEvents();
        break;
      case 'fit':
        this.onFitClick(event);
        break;
    }

    this.cdr.markForCheck();
  }

  /** I3C control names — same behavior as the Figma toolbar. */
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
    const [begin, end] = this.fullDomain;
    void this.GotoTime(begin, end);
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

  /**
   * I3C GotoTime: pad the requested span by 5% so the selected region is not flush to the edge.
   */
  async GotoTime(startTime: number, stopTime: number): Promise<void> {
    let start = startTime;
    let stop = stopTime;
    const diff = stop - start;
    start -= 0.05 * diff - EPS;
    stop += 0.05 * diff;

    if (this.start === start && this.stop === stop) {
      return;
    }

    this.start = start;
    this.stop = stop;
    this.clampWindow();
    this.resizePlot();
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
    if (!this.hasData || event.button !== 0 || !this.xScale) {
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
      event.stopPropagation();
      return;
    }

    if (this.activeTool === 'zoomOut') {
      const visibleRange = this.stop - this.start;
      const position = this.xScale.invert(x);
      this.start = position - 2 * visibleRange;
      this.stop = position + 2 * visibleRange;
      this.clampWindow();
      this.resizePlot();
      event.preventDefault();
      event.stopPropagation();
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

    if (this.activeTool === 'move') {
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

    if (this.showOverlay && this.activeTool === 'zoomIn') {
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
      this.waveformContainer?.nativeElement.parentElement?.scrollBy({ top: -dy });
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
      if (this.overlayWidth > 2 && this.xScale && this.activeTool === 'zoomIn') {
        this.start = this.xScale.invert(this.overlayX);
        this.stop = this.xScale.invert(this.overlayX + this.overlayWidth);
        this.clampWindow();
        this.resizePlot();
      }
      this.cdr.markForCheck();
    }
  }

  waveformWheel(event: WheelEvent): void {
    if (this.zoomBehavior) {
      return;
    }
    if (!this.hasData || !this.xScale) {
      return;
    }
    if (this.activeTool !== 'zoomIn' && this.activeTool !== 'zoomOut') {
      return;
    }
    event.preventDefault();
    const factor = event.deltaY > 0 ? 1.25 : 0.8;
    this.zoomAround(this.pointerX(event), factor);
  }

  waveYScale(trackIndex: number): d3.ScaleLinear<number, number> {
    const top = this.laneTop(trackIndex) + 6;
    const bottom = top + this.waveHeight - 12;
    return d3.scaleLinear().domain([-0.12, 1.12]).range([bottom, top]);
  }

  decodeYScale(trackIndex: number): d3.ScaleLinear<number, number> {
    const top = this.decodeTop(trackIndex);
    const bottom = top + this.decodeHeight - 1;
    return d3.scaleLinear().domain([-0.1, 1.1]).range([bottom, top]);
  }

  timeX(time: number): number {
    return this.xScale ? this.xScale(time) : 0;
  }

  private pointerX(event: MouseEvent): number {
    const svg = this.waveformsvg?.nativeElement;
    if (!svg) {
      return event.offsetX;
    }
    const rect = svg.getBoundingClientRect();
    return event.clientX - rect.left;
  }

  private zoomAround(pixelX: number, factor: number): void {
    const t = this.xScale.invert(pixelX);
    const range = (this.stop - this.start) * factor;
    this.start = t - range * ((t - this.start) / Math.max(this.stop - this.start, EPS));
    this.stop = this.start + range;
    this.clampWindow();
    this.resizePlot();
  }

  private shiftWindow(dxPixels: number): void {
    if (!this.xScale) {
      return;
    }
    const shift = this.xScale.invert(0) - this.xScale.invert(dxPixels);
    this.start += shift;
    this.stop += shift;
    this.clampWindow();
    this.resizePlot();
  }

  private edgesToWaveform(collection: EdgeCollection): Point[] {
    return toRawPoints(collection.firstEdgeRise, collection.edges);
  }

  /**
   * I3C first-time window: show ~1000 min-edge intervals from the capture start.
   * If that slice has no edges (trace times do not start at the file origin),
   * open the full file so the loaded trace is on screen.
   */
  private applyInitialWindow(): void {
    const [begin, end] = this.fullDomain;
    this.start = begin;
    this.stop = begin + Math.max(this.minEdgeWidth, MIN_VISIBLE_SPAN) * 1000;
    if (this.stop > end) {
      this.stop = end;
    }
    if (this.loadedTrace && !traceHasSamples(this.loadedTrace, this.start, this.stop)) {
      this.start = begin;
      this.stop = end;
    }
    this.clampWindow();
  }

  /** Draw after the waveform SVG exists. A trace loaded before the view is painted in ngAfterViewInit. */
  private paint(): void {
    if (!this.viewReady) {
      this.cdr.markForCheck();
      return;
    }
    this.cdr.detectChanges();
    this.observeSize();
    this.measurePlot();
    this.resizePlot();
    if (this.activeTool === 'select' || this.activeTool === 'pan') {
      this.setupZoom();
    }
    this.cdr.detectChanges();
  }

  private bindTraceFileEvents(): void {
    const pubsub = (globalThis as {
      PubSub?: { subscribe: (topic: string, fn: (type: string, msg: unknown) => void) => string | number };
    }).PubSub;
    if (!pubsub) {
      return;
    }
    for (const topic of ['TraceFileLoaded', 'TraceData']) {
      const token = pubsub.subscribe(topic, (_type, msg) => {
        void this.ingestLoadedTrace(msg);
      });
      this.pubsubTokens.push(token);
    }
  }

  private async ingestLoadedTrace(msg: unknown): Promise<void> {
    try {
      await this.applyLoadedTrace(msg);
    } catch (err) {
      console.error('Plot view could not read the trace file', err);
    }
  }

  private async applyLoadedTrace(msg: unknown): Promise<void> {
    if (msg == null) {
      this.loadTrace(null);
      return;
    }
    if (typeof Blob !== 'undefined' && msg instanceof Blob) {
      await this.loadTraceFile(msg);
      return;
    }
    if (typeof msg === 'string') {
      this.loadTrace(parseTraceText(msg));
      return;
    }
    if (typeof msg !== 'object') {
      return;
    }

    const record = msg as Record<string, unknown>;
    const nested = record['trace'] ?? record['data'] ?? record['capture'] ?? record['file'];
    if (typeof Blob !== 'undefined' && nested instanceof Blob) {
      await this.loadTraceFile(nested);
      return;
    }
    if (typeof nested === 'string' && nested.trim()) {
      this.loadTrace(parseTraceText(nested));
      return;
    }

    if (record['channels'] || record['Channels'] || record['buses'] || record['Buses'] || record['waveforms']) {
      this.loadTrace(parseTraceText(JSON.stringify(msg)));
      return;
    }

    const content = record['Content'] ?? record['content'] ?? record['text'];
    if (typeof content === 'string' && content.trim()) {
      const text = record['IsBinary'] === true ? decodeBase64(content) : content;
      if (looksLikeTrace(text)) {
        this.loadTrace(parseTraceText(text));
      }
    }
  }

  private clampWindow(): void {
    const [begin, end] = this.fullDomain;
    const minSpan = Math.max(MIN_VISIBLE_SPAN, this.minEdgeWidth);
    let span = this.stop - this.start;

    if (span < minSpan) {
      const center = (this.start + this.stop) / 2;
      this.start = center - minSpan / 2;
      this.stop = center + minSpan / 2;
      span = minSpan;
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
      this.stop = Math.min(end, this.start + minSpan);
    }
  }

  private clearPlot(): void {
    this.waveforms.clear();
    this.busMap.clear();
    this.wavePaths.clear();
    this.busPolygons.clear();
    this.cursorTimes = [];
    this.markerTimes = [];
  }

  private observeSize(): void {
    this.resizeObserver?.disconnect();
    const host = this.waveformContainer?.nativeElement;
    if (!host) {
      return;
    }
    this.resizeObserver = new ResizeObserver(() => {
      this.measurePlot();
      this.resizePlot();
    });
    this.resizeObserver.observe(host);
  }

  private measurePlot(): void {
    const host = this.waveformContainer?.nativeElement;
    if (!host) {
      return;
    }
    const width = host.clientWidth;
    const height = host.clientHeight;
    this.plotWidth = Math.max(240, width);
    this.plotHeight = Math.max(this.minContentHeight(), height);

    const packed = this.tracks.reduce((sum, track) => {
      const decode = track.kind === 'bus' && this.decodeEnabled ? this.decodeGap + this.decodeHeight : 0;
      return sum + this.waveHeight + decode;
    }, 0);
    const leftover = this.plotHeight - this.axisHeight - packed;
    this.laneGap = Math.max(4, Math.floor(leftover / Math.max(1, this.tracks.length)));
  }

  private minContentHeight(): number {
    return this.tracks.length * (this.waveHeight + 4) + this.decodeHeight * 2 + this.axisHeight;
  }

  private disableEvents(): void {
    const svg = this.waveformsvg?.nativeElement;
    if (svg) {
      d3.select(svg).on('.zoom', null);
    }
    this.zoomBehavior = undefined;
    this.clearZoomTransform();
    this.showOverlay = false;
    this.cdr.detectChanges();
  }

  private setupZoom(): void {
    this.disableEvents();

    const svg = this.waveformsvg?.nativeElement;
    if (!svg) {
      return;
    }

    const selection = d3.select(svg);
    this.zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 10])
      .filter((event: MouseEvent | WheelEvent) => {
        if (event.type === 'wheel') {
          return true;
        }
        return event instanceof MouseEvent && event.button === 0;
      })
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        selection
          .select('g.zoom-content')
          .attr('transform', `translate(${event.transform.x},0) scale(${event.transform.k},1)`);
      })
      .on('end', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (!event.sourceEvent || !this.xScale) {
          return;
        }
        const transform = event.transform;
        if (transform.k === 1 && Math.abs(transform.x) < 0.5) {
          return;
        }
        const [start, stop] = transform.rescaleX(this.xScale).domain();
        void this.processDomainUpdate([start, stop]);
      });

    selection.call(this.zoomBehavior);
  }

  private async processDomainUpdate(domain: [number, number]): Promise<void> {
    this.start = domain[0];
    this.stop = domain[1];
    this.clampWindow();
    this.resizePlot();
    const svg = this.waveformsvg?.nativeElement;
    if (svg && this.zoomBehavior) {
      d3.select(svg).call(this.zoomBehavior.transform, d3.zoomIdentity);
    }
    this.clearZoomTransform();
  }

  private clearZoomTransform(): void {
    const svg = this.waveformsvg?.nativeElement;
    if (!svg) {
      return;
    }
    d3.select(svg).select('g.zoom-content').attr('transform', null);
  }

  private resizePlot(): void {
    const waveWidth = Math.max(1, this.plotWidth);
    this.xScale = d3.scaleLinear().domain([this.start, this.stop]).range([0, waveWidth]);
    this.updatePlot();
    this.updateGrid(waveWidth);
    this.cdr.markForCheck();
  }

  /**
   * Rebuild wave paths and decode polygons for the current domain.
   * Visible slice is padded (2*start-stop … 2*stop-start) so pan/zoom edges stay filled.
   */
  private updatePlot(): void {
    this.wavePaths.clear();
    this.busPolygons.clear();

    if (!this.hasData) {
      return;
    }

    const visibleStart = 2 * this.start - this.stop;
    const visibleStop = 2 * this.stop - this.start;

    this.tracks.forEach((track, index) => {
      const yScale = this.waveYScale(index);
      const waveform = this.waveforms.get(track.id) ?? [];
      this.lineGenerator.x(d => this.xScale(d.x)).y(d => yScale(d.y));
      const points = toPoints(waveform, visibleStart, visibleStop, this.fullDomain);
      this.wavePaths.set(track.id, this.lineGenerator(points) ?? '');

      if (track.kind === 'bus' && this.decodeEnabled) {
        const decodeScale = this.decodeYScale(index);
        const packets = this.busMap.get(track.id) ?? [];
        const startIndex = this.busBisectorLeft(packets, visibleStart);
        const endIndex = this.busBisectorRight(packets, visibleStop);
        const visiblePackets = packets.slice(startIndex, endIndex);

        this.busPolygons.set(
          track.id,
          visiblePackets.map(packet => ({
            center: BusExtensions.getPolygonCenter(packet, this.xScale, decodeScale),
            path: BusExtensions.getPolygon(packet, this.xScale, decodeScale),
            content: packet.Content,
            startTime: packet.StartTime,
            endTime: packet.EndTime
          }))
        );
      } else {
        this.busPolygons.set(track.id, []);
      }
    });
  }

  private updateGrid(waveWidth: number): void {
    if (!this.gridEnabled) {
      this.gridLines = [];
      return;
    }

    const ticks = this.xScale.ticks(9);
    this.gridLines = ticks.map(tick => ({
      x: this.xScale(tick),
      label: this.hasData ? toEngineeringTime(tick - this.referenceTime) : ''
    }));

    if (!this.gridLines.length) {
      this.gridLines = Array.from({ length: 9 }, (_, i) => {
        const x = ((i + 1) * waveWidth) / 10;
        return {
          x,
          label: this.hasData ? toEngineeringTime(this.xScale.invert(x) - this.referenceTime) : ''
        };
      });
    }
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
      .decode-idle { stroke: #E879F9; stroke-width: 1; }
      .decode-rail { stroke: #7DD3FC; stroke-width: 1; }
    `;
    clone.insertBefore(style, clone.firstChild);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '100%');
    bg.setAttribute('height', '100%');
    bg.setAttribute('fill', '#1F1F22');
    clone.insertBefore(bg, clone.firstChild);

    const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
      type: 'image/svg+xml;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = this.plotWidth;
      canvas.height = this.plotHeight;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(image, 0, 0);
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

function looksLikeTrace(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[') || /^(time|t|timestamp)[,|\t]/i.test(trimmed);
}

function decodeBase64(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const TRACK_ALIASES: Record<string, string> = {
  busa: 'busA',
  bus_a: 'busA',
  'bus a': 'busA',
  a: 'busA',
  channelindex_busa: 'busA',
  busb: 'busB',
  bus_b: 'busB',
  'bus b': 'busB',
  b: 'busB',
  channelindex_busb: 'busB',
  ch1: 'ch1',
  channel1: 'ch1',
  'channel 1': 'ch1',
  async1: 'ch1',
  ch2: 'ch2',
  channel2: 'ch2',
  'channel 2': 'ch2',
  async2: 'ch2',
  ch3: 'ch3',
  channel3: 'ch3',
  'channel 3': 'ch3',
  async3: 'ch3',
  ch4: 'ch4',
  channel4: 'ch4',
  'channel 4': 'ch4',
  async4: 'ch4'
};

/**
 * Turn the text of a loaded trace file into plot data.
 * Accepts the TraceData JSON shape, common aliases, or a CSV of sample levels.
 */
function parseTraceText(text: string): TraceData {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Trace file is empty');
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return normalizeTrace(JSON.parse(trimmed) as unknown);
  }

  return parseLevelCsv(trimmed);
}

function normalizeTrace(raw: unknown): TraceData {
  const source = unwrapTrace(raw);
  const channels = readChannels(source);
  const buses = readBuses(source);
  const edgeTimes = allEdgeTimes(channels);
  const packetTimes = allPacketTimes(buses);

  let startTime = readNumber(source, ['startTime', 'StartTime', 'referenceTime', 'ReferenceStartTime']);
  let endTime = readNumber(source, ['endTime', 'EndTime', 'stopTime', 'StopTime']);
  const referenceTime =
    readNumber(source, ['referenceTime', 'ReferenceStartTime', 'ReferenceTime']) ?? startTime ?? edgeTimes[0] ?? 0;

  if (startTime == null) {
    startTime = Math.min(...[...edgeTimes, ...packetTimes, referenceTime]);
  }
  if (endTime == null) {
    const last = Math.max(...[...edgeTimes, ...packetTimes, startTime]);
    endTime = last > startTime ? last : startTime + MIN_VISIBLE_SPAN * 1000;
  }
  if (endTime < startTime) {
    endTime = startTime;
  }

  let minEdgeWidth = readNumber(source, ['minEdgeWidth', 'MinEdgeWidth']) ?? inferMinEdgeWidth(channels);
  if (!(minEdgeWidth > 0)) {
    minEdgeWidth = MIN_VISIBLE_SPAN;
  }

  return {
    referenceTime,
    startTime,
    endTime,
    minEdgeWidth,
    channels,
    buses
  };
}

/** Map file channel names onto the lane ids the MIL template already renders. */
function alignTraceToTracks(data: TraceData, trackIds: string[]): TraceData {
  const channels: Record<string, EdgeCollection> = {};
  const buses: Record<string, PacketBus[]> = {};
  const claimedChannels = new Set<string>();
  const claimedBuses = new Set<string>();

  const leftovers: EdgeCollection[] = [];
  Object.entries(data.channels).forEach(([id, collection]) => {
    const trackId = resolveTrackId(id, trackIds);
    if (trackId && !claimedChannels.has(trackId)) {
      claimedChannels.add(trackId);
      channels[trackId] = collection;
    } else {
      leftovers.push(collection);
    }
  });

  trackIds.forEach(trackId => {
    if (claimedChannels.has(trackId) || leftovers.length === 0) {
      return;
    }
    const next = leftovers.shift();
    if (next && next.edges.length > 0) {
      channels[trackId] = next;
      claimedChannels.add(trackId);
    }
  });

  const leftoverBuses: PacketBus[][] = [];
  Object.entries(data.buses).forEach(([id, packets]) => {
    const trackId = resolveTrackId(id, trackIds);
    if (trackId && !claimedBuses.has(trackId)) {
      claimedBuses.add(trackId);
      buses[trackId] = packets;
    } else {
      leftoverBuses.push(packets);
    }
  });

  trackIds.forEach(trackId => {
    if (claimedBuses.has(trackId) || leftoverBuses.length === 0) {
      return;
    }
    const next = leftoverBuses.shift();
    if (next && next.length > 0) {
      buses[trackId] = next;
    }
  });

  return { ...data, channels, buses };
}

function traceHasSamples(data: TraceData, start: number, stop: number): boolean {
  const channelHit = Object.values(data.channels).some(collection =>
    collection.edges.some(time => time >= start - EPS && time <= stop + EPS)
  );
  if (channelHit) {
    return true;
  }
  return Object.values(data.buses).some(packets =>
    packets.some(packet => packet.EndTime >= start - EPS && packet.StartTime <= stop + EPS)
  );
}

function unwrapTrace(raw: unknown): Record<string, unknown> {
  if (Array.isArray(raw)) {
    return { samples: raw };
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Trace file is not a JSON object');
  }

  const record = raw as Record<string, unknown>;
  for (const key of ['trace', 'data', 'capture', 'TraceData', 'plot']) {
    const nested = record[key];
    if (nested && typeof nested === 'object') {
      return nested as Record<string, unknown>;
    }
  }
  return record;
}

function readChannels(source: Record<string, unknown>): Record<string, EdgeCollection> {
  const channels: Record<string, EdgeCollection> = {};
  const bag = source['channels'] ?? source['Channels'] ?? source['waveforms'] ?? source['edges'];

  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    Object.entries(bag as Record<string, unknown>).forEach(([id, value]) => {
      const collection = toEdgeCollection(value);
      if (collection.edges.length > 0) {
        channels[id] = collection;
      }
    });
  }

  if (Object.keys(channels).length === 0 && Array.isArray(source['samples'])) {
    return channelsFromSamples(source['samples'] as unknown[]);
  }

  return channels;
}

function readBuses(source: Record<string, unknown>): Record<string, PacketBus[]> {
  const buses: Record<string, PacketBus[]> = {};
  const bag = source['buses'] ?? source['Buses'] ?? source['decode'] ?? source['packets'];
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) {
    return buses;
  }

  Object.entries(bag as Record<string, unknown>).forEach(([id, value]) => {
    if (!Array.isArray(value)) {
      return;
    }
    const packets = value
      .map(toPacket)
      .filter((packet): packet is PacketBus => packet != null)
      .sort((a, b) => a.StartTime - b.StartTime);
    if (packets.length > 0) {
      buses[id] = packets;
    }
  });
  return buses;
}

function toEdgeCollection(value: unknown): EdgeCollection {
  if (Array.isArray(value)) {
    return { firstEdgeRise: false, edges: numericList(value) };
  }
  if (!value || typeof value !== 'object') {
    return { firstEdgeRise: false, edges: [] };
  }

  const record = value as Record<string, unknown>;
  const edges = numericList(record['edges'] ?? record['Edges'] ?? record['times'] ?? []);
  const firstEdge = record['firstEdgeRise'] ?? record['FirstEdgeRise'] ?? record['firstEdge'];
  const firstEdgeRise =
    firstEdge === true || firstEdge === 'RISE' || firstEdge === 'rise' || firstEdge === 1;
  return { firstEdgeRise, edges };
}

function toPacket(value: unknown): PacketBus | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const start = readNumber(record, ['StartTime', 'startTime', 'start', 't0']);
  const end = readNumber(record, ['EndTime', 'endTime', 'end', 't1']);
  if (start == null || end == null) {
    return null;
  }
  const content = record['Content'] ?? record['content'] ?? record['text'] ?? record['label'] ?? '';
  return { StartTime: start, EndTime: end, Content: String(content) };
}

function channelsFromSamples(samples: unknown[]): Record<string, EdgeCollection> {
  const rows = samples
    .map(sample => (sample && typeof sample === 'object' ? (sample as Record<string, unknown>) : null))
    .filter((sample): sample is Record<string, unknown> => sample != null);

  const byChannel = new Map<string, { time: number; level: number }[]>();
  rows.forEach(row => {
    const time = readNumber(row, ['time', 'Time', 't', 'x']);
    const channel = String(row['channel'] ?? row['Channel'] ?? row['name'] ?? row['id'] ?? '');
    const level = readNumber(row, ['level', 'value', 'y', 'state']);
    if (time == null || level == null || !channel) {
      return;
    }
    const list = byChannel.get(channel) ?? [];
    list.push({ time, level });
    byChannel.set(channel, list);
  });

  const channels: Record<string, EdgeCollection> = {};
  byChannel.forEach((points, id) => {
    channels[id] = levelsToEdges(points);
  });
  return channels;
}

function parseLevelCsv(text: string): TraceData {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'));

  if (lines.length < 2) {
    throw new Error('Trace file has no samples');
  }

  const header = splitRow(lines[0]).map(cell => cell.trim());
  const timeIndex = header.findIndex(cell => /^(time|t|timestamp)$/i.test(cell));
  if (timeIndex < 0) {
    throw new Error('Trace CSV needs a time column');
  }

  const series = new Map<string, { time: number; level: number }[]>();
  header.forEach((name, index) => {
    if (index !== timeIndex && name) {
      series.set(name, []);
    }
  });

  for (let rowIndex = 1; rowIndex < lines.length; rowIndex++) {
    const cells = splitRow(lines[rowIndex]);
    const time = Number(cells[timeIndex]);
    if (!Number.isFinite(time)) {
      continue;
    }
    header.forEach((name, index) => {
      if (index === timeIndex || !name) {
        return;
      }
      const level = Number(cells[index]);
      if (Number.isFinite(level)) {
        series.get(name)?.push({ time, level });
      }
    });
  }

  const channels: Record<string, EdgeCollection> = {};
  series.forEach((points, name) => {
    if (points.length > 0) {
      channels[name] = levelsToEdges(points);
    }
  });

  return normalizeTrace({ channels });
}

function levelsToEdges(points: { time: number; level: number }[]): EdgeCollection {
  const ordered = [...points].sort((a, b) => a.time - b.time);
  const firstHigh = ordered[0].level >= 0.5;
  const edges: number[] = [ordered[0].time];
  let level = firstHigh;
  for (let index = 1; index < ordered.length; index++) {
    const nextHigh = ordered[index].level >= 0.5;
    if (nextHigh !== level) {
      edges.push(ordered[index].time);
      level = nextHigh;
    }
  }
  return { firstEdgeRise: firstHigh, edges };
}

function inferMinEdgeWidth(channels: Record<string, EdgeCollection>): number {
  let min = Number.POSITIVE_INFINITY;
  Object.values(channels).forEach(collection => {
    const edges = [...collection.edges].sort((a, b) => a - b);
    const limit = Math.min(edges.length, 1001);
    for (let index = 1; index < limit; index++) {
      const delta = edges[index] - edges[index - 1];
      if (delta > EPS && delta < min) {
        min = delta;
      }
    }
  });
  return Number.isFinite(min) ? min : MIN_VISIBLE_SPAN;
}

function resolveTrackId(id: string, trackIds: string[]): string | null {
  if (trackIds.includes(id)) {
    return id;
  }
  const alias = TRACK_ALIASES[id.trim().toLowerCase()];
  if (alias && trackIds.includes(alias)) {
    return alias;
  }
  return null;
}

function numericList(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(item => Number(item)).filter(item => Number.isFinite(item));
}

function readNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function allEdgeTimes(channels: Record<string, EdgeCollection>): number[] {
  return Object.values(channels).flatMap(collection => collection.edges);
}

function allPacketTimes(buses: Record<string, PacketBus[]>): number[] {
  return Object.values(buses).flatMap(packets => packets.flatMap(packet => [packet.StartTime, packet.EndTime]));
}

function splitRow(line: string): string[] {
  return line.includes('\t') ? line.split('\t') : line.split(',');
}
