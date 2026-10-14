import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface PlotChannelChoice {
  id: string;
  name: string;
  color: string;
  checked?: boolean;
}

export interface BusChannelSelection {
  source: 'Bus A' | 'Bus B';
  sampleRate: 125 | 250 | 500;
  channels: PlotChannelChoice[];
}

@Injectable({ providedIn: 'root' })
export class BusChannelSelectionService {
  private readonly selectionSubject = new BehaviorSubject<BusChannelSelection>({
    source: 'Bus A',
    sampleRate: 125,
    channels: []
  });

  readonly selection$ = this.selectionSubject.asObservable();

  update(selection: BusChannelSelection): void {
    this.selectionSubject.next(selection);
  }
}
