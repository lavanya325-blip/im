import * as d3 from 'd3';

/**
 * Configuration options for the D3ZoomHandler.
 */
export interface D3ZoomHandlerOptions {
  scaleExtent?: [number, number];
  scrollEndDelay?: number;
  panMomentumDecay?: number;
  zoomMomentumDecay?: number;
  panVelocityThreshold?: number;
  zoomVelocityThreshold?: number;
  mouseWheelSensitivity?: number;
  trackpadSensitivity?: number;
  touchVelocityDampener?: number;
  mouseWheelVelocityDampener?: number;
  zoomMomentumSensitivity?: number;
}

/**
 * Callbacks for handling zoom events.
 */
export interface D3ZoomHandlerCallbacks {
  /** Fired continuously during a zoom/pan interaction for live updates. */
  onTransform: (transform: d3.ZoomTransform) => void;
  /** Fired after an interaction (and any momentum) has completely finished. */
  onTransformEnd: (finalTransform: d3.ZoomTransform) => void;
}

/**
 * A utility class to manage complex D3 zooming and panning behavior
 * with momentum, custom wheel handling, and a clean event-based API.
 */
export class D3ZoomHandler {
  // --- Configuration & Dependencies ---
  private readonly options: Required<D3ZoomHandlerOptions>;
  private readonly svgElement: SVGElement;
  private readonly callbacks: D3ZoomHandlerCallbacks;

  // --- Core State ---
  private zoomBehavior: d3.ZoomBehavior<SVGElement, unknown>;
  private interactionTransform = d3.zoomIdentity;
  private renderTransform = d3.zoomIdentity;
  private previousTransform = d3.zoomIdentity; // For velocity calculation

  // --- Interaction & Momentum State ---
  private isInteracting = false;
  private panVelocity = 0;
  private zoomVelocity = 0;
  private lastInteractionTime = 0;
  private lastInteractionType: string | null = null;
  private wasLastInteractionMouseWheel = false;
  private zoomCenter: [number, number] = [0, 0];

  // --- Timers & Animation Frames ---
  private renderTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private animationFrameId: number | null = null;

  private static readonly DEFAULT_OPTIONS: Required<D3ZoomHandlerOptions> = {
    scaleExtent: [0.1, 10],
    scrollEndDelay: 150,
    panMomentumDecay: 0.96,
    zoomMomentumDecay: 0.85,
    panVelocityThreshold: 0.1,
    zoomVelocityThreshold: 0.0005,
    mouseWheelSensitivity: 0.4,
    trackpadSensitivity: 1.0,
    touchVelocityDampener: 0.5,
    mouseWheelVelocityDampener: 0.25,
    zoomMomentumSensitivity: 0.2,
  };

  constructor(
    svgElement: SVGElement,
    callbacks: D3ZoomHandlerCallbacks,
    options: D3ZoomHandlerOptions = {}
  ) {
    this.svgElement = svgElement;
    this.callbacks = callbacks;
    this.options = { ...D3ZoomHandler.DEFAULT_OPTIONS, ...options };

    this.zoomBehavior = this._createZoomBehavior();
  }

  /**
   * Initializes the zoom handler and attaches it to the SVG element.
   */
  public init(): void {
    d3.select(this.svgElement).call(this.zoomBehavior);
  }

  /**
   * Resets the internal zoom state to identity. This should be called
   * after the consumer has "baked" the final transform into its own scales.
   */
  public reset(): void {
    this.interactionTransform = d3.zoomIdentity;
    this.renderTransform = d3.zoomIdentity;
    this.previousTransform = d3.zoomIdentity;

    // Synchronize D3's internal state
    this.zoomBehavior.transform(d3.select(this.svgElement), d3.zoomIdentity);
  }

  /**
   * Removes all event listeners and cleans up resources.
   */
  public destroy(): void {
    this._cancelMomentum();
    if (this.renderTimeoutId) {
      clearTimeout(this.renderTimeoutId);
    }
    // Remove all D3 zoom event listeners
    d3.select(this.svgElement).on('.zoom', null);
  }

  // --- Private: Core Zoom Behavior Setup ---

  private _createZoomBehavior(): d3.ZoomBehavior<SVGElement, unknown> {
    return d3.zoom<SVGElement, unknown>()
      .scaleExtent(this.options.scaleExtent)
      .translateExtent([[-Infinity, 0], [Infinity, 0]])
      .filter(this._filterEvents.bind(this))
      .wheelDelta(this._calculateWheelDelta.bind(this))
      .constrain(transform => new d3.ZoomTransform(transform.k, transform.x, 0))
      .on('start', this._onZoomStart.bind(this))
      .on('zoom', this._onZoom.bind(this))
      .on('end', this._onZoomEnd.bind(this));
  }

  // --- Private: D3 Event Handlers ---

  private _filterEvents(event: WheelEvent | MouseEvent | TouchEvent): boolean {
    if (event.type === 'mousedown' && (event as MouseEvent).button !== 0) {
      return false; // Only allow primary mouse button
    }
    if (event.type !== 'touchstart' && event.type !== 'touchmove') {
      event.preventDefault();
    }
    return true;
  }

  private _calculateWheelDelta(event: WheelEvent): number {
    const DEFAULT_D3_FACTOR = 0.002;
    const isMouseWheel = Math.abs(event.deltaY) >= 10 && Math.floor(event.deltaY) === event.deltaY;
    const sensitivity = isMouseWheel ? this.options.mouseWheelSensitivity : this.options.trackpadSensitivity;
    return -event.deltaY * DEFAULT_D3_FACTOR * sensitivity;
  }

  private _onZoomStart(event: d3.D3ZoomEvent<SVGElement, unknown>): void {
    if (event.sourceEvent) {
      this._cancelMomentum();
      this.isInteracting = true;
      this.lastInteractionTime = performance.now();
      this.previousTransform = this.interactionTransform;
    }
  }

  private _onZoom(event: d3.D3ZoomEvent<SVGElement, unknown>): void {
    if (!event.sourceEvent) return;

    this._updateInteractionType(event.sourceEvent);

    if (this.lastInteractionType === 'shift-wheel-pan') {
      this._handleShiftWheelPan(event.sourceEvent as WheelEvent);
    } else {
      this._handleStandardZoom(event);
    }

    this._updateVelocities(event);
    this._updateTimestampsAndTransforms(this.interactionTransform);

    // Immediately notify consumer of the live transform
    this.callbacks.onTransform(this.interactionTransform);
    this._scheduleRender();
  }

  private _onZoomEnd(): void {
    if (!this.isInteracting) return;

    this.isInteracting = false;
    this.lastInteractionType = null;

    // Do not apply momentum for discrete mouse wheel scrolls
    if (this.wasLastInteractionMouseWheel) {
      this._scheduleRender();
      return;
    }

    // Apply momentum for trackpad and drag gestures
    if (Math.abs(this.panVelocity) > this.options.panVelocityThreshold) {
      this._applyPanMomentum();
    } else if (Math.abs(this.zoomVelocity) > this.options.zoomVelocityThreshold) {
      this._applyZoomMomentum();
    } else {
      this._scheduleRender();
    }
  }

  // --- Private: Zoom/Pan Logic ---

  private _handleShiftWheelPan(event: WheelEvent): void {
    const panDelta = event.deltaX !== 0 ? -event.deltaX : -event.deltaY;
    const clampedDelta = Math.max(-100, Math.min(100, panDelta));
    const dx = (clampedDelta * 0.5) / this.previousTransform.k;

    const newTransform = this.previousTransform.translate(dx, 0);
    this.interactionTransform = newTransform;

    // Manually sync D3's internal state since we're overriding its transform
    (d3.select(this.svgElement).node() as any).__zoom = newTransform;
  }

  private _handleStandardZoom(event: d3.D3ZoomEvent<SVGElement, unknown>): void {
    this.interactionTransform = event.transform;
    if (event.sourceEvent?.type === 'wheel') {
      this.zoomCenter = [(event.sourceEvent as WheelEvent).offsetX, 0];
    }
  }

  // --- Private: Velocity & Momentum ---

  private _updateInteractionType(sourceEvent: Event): void {
    let currentType: string | null = null;
    const isWheel = sourceEvent.type === 'wheel';
    const isMouseMove = sourceEvent.type === 'mousemove';
    const isTouchMove = sourceEvent.type === 'touchmove';

    if (isWheel && (sourceEvent as WheelEvent).shiftKey) {
      currentType = 'shift-wheel-pan';
    } else if (isWheel) {
      currentType = 'wheel-zoom';
    } else if (isMouseMove) {
      currentType = 'drag-pan';
    } else if (isTouchMove) {
      currentType = 'touch';
    }

    // Reset velocities if the type of interaction changes mid-stream
    if (this.lastInteractionType !== currentType) {
      this.panVelocity = 0;
      this.zoomVelocity = 0;
    }
    this.lastInteractionType = currentType;

    // Check if the source is a discrete mouse wheel click
    this.wasLastInteractionMouseWheel = isWheel && Math.abs((sourceEvent as WheelEvent).deltaY) >= 10 && Math.floor((sourceEvent as WheelEvent).deltaY) === (sourceEvent as WheelEvent).deltaY;
  }

  private _updateVelocities(event: d3.D3ZoomEvent<SVGElement, unknown>): void {
    const now = performance.now();
    const dt = now - this.lastInteractionTime;
    if (dt <= 0) return;

    const dx = this.interactionTransform.x - this.previousTransform.x;
    const dk = this.interactionTransform.k - this.previousTransform.k;
    const alpha = 0.4; // Smoothing factor for velocity

    switch (event.sourceEvent?.type) {
      case 'mousemove':
      case 'touchmove':
        if ((event.sourceEvent as TouchEvent).touches?.length === 1 || isNaN((event.sourceEvent as TouchEvent).touches?.length)) {
          this.zoomVelocity = 0;
          this.panVelocity = alpha * (dx / dt) + (1 - alpha) * this.panVelocity;
        } else { // Pinch-to-zoom
          this.panVelocity = 0;
          let newZoomVelocity = (dk / dt) * this.options.touchVelocityDampener;
          this.zoomVelocity = alpha * newZoomVelocity + (1 - alpha) * this.zoomVelocity;
          const touches = (event.sourceEvent as TouchEvent).touches;
          this.zoomCenter = [(touches[0].clientX + touches[1].clientX) / 2, 0];
        }
        break;

      case 'wheel':
        this.panVelocity = (this.lastInteractionType === 'shift-wheel-pan') ? alpha * (dx / dt) + (1 - alpha) * this.panVelocity : 0;
        let newZoomVelocity = dk / dt;
        if (this.wasLastInteractionMouseWheel) {
          newZoomVelocity *= this.options.mouseWheelVelocityDampener;
        }
        this.zoomVelocity = (this.lastInteractionType === 'wheel-zoom') ? alpha * newZoomVelocity + (1 - alpha) * this.zoomVelocity : 0;
        break;
    }
  }

  private _updateTimestampsAndTransforms(newTransform: d3.ZoomTransform): void {
    this.lastInteractionTime = performance.now();
    this.previousTransform = newTransform;
  }

  private _applyPanMomentum(): void {
    let lastTime = performance.now();
    const step = (timestamp: number) => {
      if (this.isInteracting) { this._cancelMomentum(); return; }
      if (Math.abs(this.panVelocity) < this.options.panVelocityThreshold) {
        this._cancelMomentum();
        this._scheduleRender();
        return;
      }

      const dt = timestamp - lastTime;
      lastTime = timestamp;
      const dx = (this.panVelocity * dt) / this.interactionTransform.k;

      this.interactionTransform = this.interactionTransform.translate(dx, 0);
      this.panVelocity *= this.options.panMomentumDecay;

      this.zoomBehavior.transform(d3.select(this.svgElement), this.interactionTransform);
      this.callbacks.onTransform(this.interactionTransform);
      this.animationFrameId = requestAnimationFrame(step);
    };
    this.animationFrameId = requestAnimationFrame(step);
  }

  private _applyZoomMomentum(): void {
    let lastTime = performance.now();
    const step = (timestamp: number) => {
      if (this.isInteracting) { this._cancelMomentum(); return; }
      if (Math.abs(this.zoomVelocity) < this.options.zoomVelocityThreshold) {
        this._cancelMomentum();
        this._scheduleRender();
        return;
      }

      const dt = timestamp - lastTime;
      lastTime = timestamp;

      const scaleChange = this.zoomVelocity * dt * this.options.zoomMomentumSensitivity;
      const newScale = this.interactionTransform.k * (1 + scaleChange);
      const clampedScale = Math.max(this.options.scaleExtent[0], Math.min(this.options.scaleExtent[1], newScale));

      const centerX = this.zoomCenter[0] || this.svgElement.clientWidth / 2;
      const newX = this.interactionTransform.x + (centerX - this.interactionTransform.x) * (1 - clampedScale / this.interactionTransform.k);

      this.interactionTransform = new d3.ZoomTransform(clampedScale, newX, 0);
      this.zoomVelocity *= this.options.zoomMomentumDecay;

      this.zoomBehavior.transform(d3.select(this.svgElement), this.interactionTransform);
      this.callbacks.onTransform(this.interactionTransform);
      this.animationFrameId = requestAnimationFrame(step);
    };
    this.animationFrameId = requestAnimationFrame(step);
  }

  private _cancelMomentum(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.panVelocity = 0;
    this.zoomVelocity = 0;
  }

  // --- Private: Rendering & Finalization ---

  private _scheduleRender(): void {
    if (this.renderTimeoutId) {
      clearTimeout(this.renderTimeoutId);
    }
    this.renderTransform = this.interactionTransform;

    const isMomentumActive = this.animationFrameId !== null;
    if (!this.isInteracting && !isMomentumActive) {
      this.renderTimeoutId = setTimeout(() => {
        this.callbacks.onTransformEnd(this.renderTransform);
      }, this.options.scrollEndDelay);
    }
  }
}
