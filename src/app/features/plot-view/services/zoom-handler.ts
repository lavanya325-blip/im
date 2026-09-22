import * as d3 from 'd3';

export interface D3ZoomHandlerCallbacks {
  onTransform: (transform: d3.ZoomTransform) => void;
  onTransformEnd: (finalTransform: d3.ZoomTransform) => void | Promise<void>;
}

export class D3ZoomHandler {
  private zoomBehavior?: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private selection?: d3.Selection<SVGSVGElement, unknown, null, undefined>;

  constructor(
    private readonly element: SVGSVGElement,
    private readonly callbacks: D3ZoomHandlerCallbacks,
    private readonly config: { scaleExtent?: [number, number] } = {}
  ) {}

  init(): void {
    this.selection = d3.select(this.element);
    this.zoomBehavior = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent(this.config.scaleExtent ?? [0.1, 10])
      .filter((event: MouseEvent | WheelEvent) => {
        if (event.type === 'wheel') {
          return true;
        }
        return event instanceof MouseEvent && event.button === 0;
      })
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        this.callbacks.onTransform(event.transform);
      })
      .on('end', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (!event.sourceEvent) {
          return;
        }
        const transform = event.transform;
        if (transform.k === 1 && Math.abs(transform.x) < 0.5) {
          return;
        }
        void this.callbacks.onTransformEnd(transform);
      });

    this.selection.call(this.zoomBehavior);
  }

  reset(): void {
    if (!this.selection || !this.zoomBehavior) {
      return;
    }
    this.selection.call(this.zoomBehavior.transform, d3.zoomIdentity);
  }

  destroy(): void {
    this.selection?.on('.zoom', null);
    this.zoomBehavior = undefined;
    this.selection = undefined;
  }
}
