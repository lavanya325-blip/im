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
import { D3ZoomHandler, D3ZoomHandlerCallbacks } from './services/zoom-handler';

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
  private zoomHandler?: D3ZoomHandler;
  private readonly lineGenerator = d3.line<Point>().curve(d3.curveStepAfter);
  private readonly busBisectorLeft = d3.bisector((d: PacketBus) => d.EndTime).left;
  private readonly busBisectorRight = d3.bisector((d: PacketBus) => d.StartTime).right;

  constructor(private cdr: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    this.observeSize();
    this.measurePlot();
    this.resizePlot();
    this.setupZoom();
  }

  ngOnDestroy(): void {
    this.zoomHandler?.destroy();
    this.resizeObserver?.disconnect();
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
   * response into TraceData and call this.
   */
  loadTrace(data: TraceData | null): void {
    this.clearPlot();

    if (!data) {
      this.hasData = false;
      this.cdr.detectChanges();
      this.observeSize();
      this.measurePlot();
      this.resizePlot();
      this.cdr.markForCheck();
      return;
    }

    this.minEdgeWidth = data.minEdgeWidth || MIN_VISIBLE_SPAN;
    this.referenceTime = data.referenceTime;
    this.fullDomain = [data.startTime, data.endTime];

    Object.entries(data.channels).forEach(([id, collection]) => {
      this.waveforms.set(id, this.edgesToWaveform(collection));
    });
    Object.entries(data.buses).forEach(([id, packets]) => {
      this.busMap.set(id, [...packets].sort((a, b) => a.StartTime - b.StartTime));
    });

    this.applyInitialWindow();
    this.hasData = this.waveforms.size > 0;
    this.cdr.detectChanges();
    this.observeSize();
    this.measurePlot();
    this.resizePlot();
    this.setupZoom();
    this.cdr.markForCheck();
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
    if (this.zoomHandler) {
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
   */
  private applyInitialWindow(): void {
    const [begin, end] = this.fullDomain;
    this.start = begin;
    this.stop = begin + this.minEdgeWidth * 1000;
    if (this.stop > end) {
      this.stop = end;
    }
    this.clampWindow();
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
    this.zoomHandler?.destroy();
    this.zoomHandler = undefined;
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

    const zoomCallbacks: D3ZoomHandlerCallbacks = {
      onTransform: transform => {
        d3.select(svg)
          .select('g.zoom-content')
          .attr('transform', `translate(${transform.x},0) scale(${transform.k},1)`);
      },
      onTransformEnd: async finalTransform => {
        if (!this.xScale) {
          return;
        }
        const newDomain = finalTransform.rescaleX(this.xScale).domain();
        await this.processDomainUpdate([newDomain[0], newDomain[1]]);
      }
    };

    this.zoomHandler = new D3ZoomHandler(svg, zoomCallbacks, { scaleExtent: [0.1, 10] });
    this.zoomHandler.init();
  }

  private async processDomainUpdate(domain: [number, number]): Promise<void> {
    this.start = domain[0];
    this.stop = domain[1];
    this.clampWindow();
    this.resizePlot();
    this.zoomHandler?.reset();
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
