import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { zoomIdentity, ZoomTransform } from 'd3-zoom';

@Injectable({ providedIn: 'root' })
export class ZoomStateService {
  // A BehaviorSubject holds the *current* value and emits future values.
  // We initialize it with the default d3.zoomIdentity.
  private readonly _transform = new BehaviorSubject<ZoomTransform>(zoomIdentity);

  // Expose the transform state as a read-only Observable for components to subscribe to.
  public readonly transform$: Observable<ZoomTransform> = this._transform.asObservable();

  /**
   * Updates the current zoom transform state.
   * @param newTransform The new transform object from the D3 zoom event.
   */
  public updateTransform(newTransform: ZoomTransform): void {
    this._transform.next(newTransform);
  }

  /**
   * Gets the current, instantaneous value of the transform.
   */
  public getCurrentTransform(): ZoomTransform {
    return this._transform.getValue();
  }
}
