import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ChannelSelection } from '../../shared/models/channel-selection.model';

@Injectable({ providedIn: 'root' })
export class ChannelPlotBridgeService {
  private readonly selection$ = new BehaviorSubject<ChannelSelection | null>(null);

  readonly channelSelection$ = this.selection$.asObservable();

  publish(selection: ChannelSelection): void {
    this.selection$.next(selection);
  }
}
