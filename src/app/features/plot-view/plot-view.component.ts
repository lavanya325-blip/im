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
/** I3C zoom-in limit: visible plot should not be less than 1 ns. */
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
  flags: number[] = [];

  showOverlay = false;
  overlayX = 20;
  overlayWidth = 100;
  private overlayx0 = 0;
  private zoomInEnabled = false;
  private zoomOutEnabled = false;
  private dragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

  plotWidth = 800;
  plotHeight = 520;
  readonly axisHeight = 24;
  readonly waveHeight = 52;
  readonly decodeGap = 4;
  laneGap = 8;
  readonly decodeHeight = 19;

  xScale!: d3.ScaleLinear<number, number>;
  yScale!: d3.ScaleLinear<number, number>;
  wavePaths = new Map<string, string>();
  busPolygons = new Map<string, BusPolygon[]>();
  gridLines: { x: number; label: string }[] = [];

  private waveforms = new Map<string, Point[]>();
  private busMap = new Map<string, PacketBus[]>();
  private fullDomain: [number, number] = [0, 1];
  private start = 0;
  private stop = 1;
  private minEdgeWidth = MIN_VISIBLE_SPAN;
  private referenceTime = 0;
  private resizeObserver?: ResizeObserver;
  private zoomBehavior?: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private readonly lineGenerator = d3.line<Point>().curve(d3.curveStepAfter);
  private readonly busBisectorLeft = d3.bisector((d: PacketBus) => d.EndTime).left;
  private readonly busBisectorRight = d3.bisector((d: PacketBus) => d.StartTime).right;

  constructor(private cdr: ChangeDetectorRef) {}

  ngAfterViewInit(): void {
    this.resizeObserver = new ResizeObserver(() => {
      this.measurePlot();
      this.resizePlot();
    });
    if (this.waveformsvg?.nativeElement) {
      this.resizeObserver.observe(this.waveformsvg.nativeElement);
    } else if (this.waveformContainer?.nativeElement) {
      this.resizeObserver.observe(this.waveformContainer.nativeElement);
    }

    this.measurePlot();
    this.resizePlot();
    this.setupZoom();
  }

  ngOnDestroy(): void {
    this.disableEvents();
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

  loadTrace(data: TraceData | null): void {
    this.cleanWaveformData();

    if (!data) {
      this.hasData = false;
      this.resizePlot();
      return;
    }

    this.minEdgeWidth = data.minEdgeWidth || MIN_VISIBLE_SPAN;
    this.referenceTime = data.referenceTime;
    this.fullDomain = [data.startTime, data.endTime];

    Object.entries(data.channels).forEach(([id, collection]) => {
      this.waveforms.set(id, this.toRawPoints(collection));
    });
    Object.entries(data.buses).forEach(([id, packets]) => {
      this.busMap.set(id, [...packets].sort((a, b) => a.StartTime - b.StartTime));
    });

    this.applyInitialWindow();
    this.hasData = this.waveforms.size > 0;
    this.measurePlot();
    this.resizePlot();
    this.setupZoom();
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
    if (tool === 'zoomIn') {
      return this.zoomInEnabled;
    }
    if (tool === 'zoomOut') {
      return this.zoomOutEnabled;
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
        this.onEnableGrid(event as MouseEvent);
        break;
      case 'flag':
        this.onBitsClick(event as MouseEvent);
        break;
      case 'cursor':
        this.onCursorEnableClick(undefined, event);
        break;
      case 'select':
        this.onMouseEnableClick(event as MouseEvent);
        break;
      case 'pan':
        this.onPanClick(event as MouseEvent);
        break;
      case 'zoomIn':
        this.onZoomInClick(event as MouseEvent);
        break;
      case 'zoomOut':
        this.onZoomOutClick(event as MouseEvent);
        break;
      case 'move':
        this.activeTool = 'move';
        this.selectEnabled = false;
        this.cursorEnabled = false;
        this.disableEvents();
        break;
      case 'fit':
        this.onFitClick(event as MouseEvent);
        break;
    }

    this.cdr.markForCheck();
  }

  onMouseEnableClick(_event: MouseEvent): void {
    this.activeTool = 'select';
    this.selectEnabled = true;
    this.cursorEnabled = false;
    this.setupZoom();
  }

  onZoomInClick(_event: MouseEvent): void {
    this.disableEvents();
    this.activeTool = 'zoomIn';
    this.zoomInEnabled = true;
    this.selectEnabled = false;
    this.cursorEnabled = false;
  }

  onZoomOutClick(_event: MouseEvent): void {
    this.disableEvents();
    this.activeTool = 'zoomOut';
    this.zoomOutEnabled = true;
    this.selectEnabled = false;
    this.cursorEnabled = false;
  }

  onPanClick(event: MouseEvent): void {
    this.activeTool = 'pan';
    this.selectEnabled = false;
    this.cursorEnabled = false;
    this.onMouseEnableClick(event);
    this.activeTool = 'pan';
  }

  onFitClick(_event?: Event): void {
    const [begin, end] = this.fullDomain;
    void this.GotoTime(begin, end);
  }

  onCursorEnableClick(_model: unknown, _event?: Event): void {
    this.disableEvents();
    this.activeTool = 'cursor';
    this.cursorEnabled = true;
    this.selectEnabled = false;
  }

  onEnableGrid(_event: MouseEvent): void {
    this.gridEnabled = !this.gridEnabled;
    this.resizePlot();
  }

  onBitsClick(_event: MouseEvent): void {
    this.decodeEnabled = !this.decodeEnabled;
    this.measurePlot();
    this.resizePlot();
  }

  SaveImage(): void {
    this.capturePlot();
  }

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
    this.waveform_mousemove(event);
  }

  waveformMouseup(event: MouseEvent): void {
    this.waveform_mouseup(event);
  }

  waveformMousedown(event: MouseEvent): void {
    this.waveform_mousedown(event);
  }

  async waveform_mousedown(event: MouseEvent): Promise<void> {
    if (!this.hasData || !this.xScale) {
      return;
    }

    const x = this.pointerX(event);
    this.lastPointerX = x;
    this.lastPointerY = event.clientY;

    if (event.button === 0) {
      if (this.zoomInEnabled) {
        this.dragging = true;
        this.showOverlay = true;
        this.overlayx0 = x;
        this.overlayX = this.overlayx0;
        this.overlayWidth = 0;
        event.stopPropagation();
        return;
      }

      if (this.zoomOutEnabled) {
        const visibleRange = this.stop - this.start;
        const position = this.xScale.invert(x);
        this.start = position - 2 * visibleRange;
        this.stop = position + 2 * visibleRange;
        this.clampWindow();
        this.resizePlot();
        event.stopPropagation();
        return;
      }

      if (this.activeTool === 'cursor') {
        this.cursorTimes = [...this.cursorTimes.slice(-1), this.xScale.invert(x)];
        this.cursorEnabled = true;
        this.cdr.markForCheck();
        event.preventDefault();
        return;
      }

      if (this.activeTool === 'move') {
        this.dragging = true;
        event.preventDefault();
      }
    } else if (event.button === 1 && !this.zoomInEnabled && !this.zoomOutEnabled) {
      this.dragging = true;
      this.showOverlay = true;
      this.overlayx0 = x;
      this.overlayX = this.overlayx0;
      this.overlayWidth = 0;
      event.stopPropagation();
    }
  }

  waveform_mousemove(event: MouseEvent): void {
    if (!this.dragging && !this.showOverlay) {
      return;
    }

    const x = this.pointerX(event);
    const dx = x - this.lastPointerX;
    const dy = event.clientY - this.lastPointerY;
    this.lastPointerX = x;
    this.lastPointerY = event.clientY;

    if (this.showOverlay) {
      if (x >= this.overlayx0) {
        this.overlayX = this.overlayx0;
        this.overlayWidth = x - this.overlayx0;
      } else {
        this.overlayX = x;
        this.overlayWidth = this.overlayx0 - x;
      }
      event.stopPropagation();
      this.cdr.markForCheck();
      return;
    }

    if (this.activeTool === 'move') {
      this.shiftWindow(dx);
      this.waveformContainer?.nativeElement.parentElement?.scrollBy({ top: -dy });
    }
  }

  waveform_mouseup(event: MouseEvent): void {
    if ((event.button === 0 || event.button === 1) && this.showOverlay) {
      this.showOverlay = false;
      this.dragging = false;

      if (this.overlayWidth > 2 && this.xScale) {
        this.start = this.xScale.invert(this.overlayX);
        this.stop = this.xScale.invert(this.overlayX + this.overlayWidth);
        this.clampWindow();
        this.resizePlot();
      }

      event.stopPropagation();
      this.cdr.markForCheck();
      return;
    }

    this.dragging = false;
  }

  @HostListener('document:mousemove', ['$event'])
  onDocumentMove(event: MouseEvent): void {
    if (this.dragging || this.showOverlay) {
      this.waveform_mousemove(event);
    }
  }

  @HostListener('document:mouseup', ['$event'])
  onDocumentUp(event: MouseEvent): void {
    if (this.dragging || this.showOverlay) {
      this.waveform_mouseup(event);
    }
  }

  waveformWheel(event: WheelEvent): void {
    if (this.zoomBehavior) {
      return;
    }
    if (!this.hasData || !this.xScale) {
      return;
    }
    if (!this.zoomInEnabled && !this.zoomOutEnabled) {
      return;
    }
    event.preventDefault();
    const factor = event.deltaY > 0 ? 1.25 : 0.8;
    this.zoomAround(this.pointerX(event), factor);
  }

  waveYScale(trackIndex: number): d3.ScaleLinear<number, number> {
    const top = this.laneTop(trackIndex) + 6;
    const bottom = top + this.waveHeight - 12;
    return d3.scaleLinear().domain([-0.1, 1.1]).range([bottom, top]);
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

  private toRawPoints(collection: EdgeCollection): Point[] {
    return toRawPoints(collection.firstEdgeRise, collection.edges);
  }

  /** I3C first-time visible window: start … start + minEdgeWidth * 1000. */
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

  private cleanWaveformData(): void {
    this.waveforms.clear();
    this.busMap.clear();
    this.wavePaths.clear();
    this.busPolygons.clear();
    this.cursorTimes = [];
    this.markerTimes = [];
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
      d3.select(svg).select('g.zoom-content').attr('transform', null);
    }
    this.zoomBehavior = undefined;
    this.showOverlay = false;
    this.zoomInEnabled = false;
    this.zoomOutEnabled = false;
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
        const newDomain = transform.rescaleX(this.xScale).domain();
        void this.processDomainUpdate([newDomain[0], newDomain[1]]);
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
    d3.select(this.waveformsvg!.nativeElement).select('g.zoom-content').attr('transform', null);
  }

  resizePlot(): void {
    const clientWidth = Math.max(1, this.plotWidth);
    const busTracks = this.tracks.filter(track => track.kind === 'bus').length || 1;
    const channelTracks = this.tracks.filter(track => track.kind === 'channel').length || 1;

    this.xScale = d3.scaleLinear().domain([this.start, this.stop]).range([0, clientWidth]);
    this.yScale = d3
      .scaleLinear()
      .domain([0, channelTracks])
      .range([this.plotHeight - this.axisHeight - this.decodeHeight * busTracks, 0]);

    this.updatePlot();
    this.updateGrid(clientWidth);
    this.cdr.detectChanges();
  }

  updatePlot(): void {
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

        this.busPolygons.set(
          track.id,
          packets.slice(startIndex, endIndex).map(packet => ({
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
