import { CommonModule } from '@angular/common';
import { Component, EventEmitter, OnInit, Output, inject } from '@angular/core';

import { AcquisitionConfigurationComponent } from '../acquisition-configuration/acquisition-configuration.component';
import { TriggerConfigurationComponent } from '../trigger-configuration/trigger-configuration.component';
import {
  BUS_CHANNEL_COLORS,
  BusSource,
  Channel,
  ChannelSelection,
  SampleRate,
  defaultChannelWhenEmpty
} from '../shared/models/channel-selection.model';
import { ChannelPlotBridgeService } from '../plot-view/services/channel-plot-bridge.service';

@Component({
  selector: 'app-bus-configuration',
  standalone: true,
  imports: [
    CommonModule,
    TriggerConfigurationComponent,
    AcquisitionConfigurationComponent
  ],
  templateUrl: './bus-configuration.component.html',
  styleUrls: ['./bus-configuration.component.css']
})
export class BusConfigurationComponent implements OnInit {
  private readonly plotBridge = inject(ChannelPlotBridgeService);

  selectedSource: BusSource = 'Bus A';
  sampleRate: SampleRate = 125;

  @Output()
  channelSelectionChanged = new EventEmitter<ChannelSelection>();

  channels: Channel[] = [
    { id: 'CH1', name: 'CH1', checked: false, color: BUS_CHANNEL_COLORS.CH1 },
    { id: 'CH2', name: 'CH2', checked: false, color: BUS_CHANNEL_COLORS.CH2 },
    { id: 'CH3', name: 'CH3', checked: false, color: BUS_CHANNEL_COLORS.CH3 },
    { id: 'CH4', name: 'CH4', checked: false, color: BUS_CHANNEL_COLORS.CH4 },
    { id: 'CH5', name: 'CH5', checked: false, color: BUS_CHANNEL_COLORS.CH5 },
    { id: 'CH6', name: 'CH6', checked: false, color: BUS_CHANNEL_COLORS.CH6 },
    { id: 'CH7', name: 'CH7', checked: false, color: BUS_CHANNEL_COLORS.CH7 },
    { id: 'CH8', name: 'CH8', checked: false, color: BUS_CHANNEL_COLORS.CH8 }
  ];

  ngOnInit(): void {
    this.emitChannelSelection();
  }

  get visibleChannels(): Channel[] {
    return this.channels.slice(0, this.getChannelCount());
  }

  private getChannelCount(): number {
    switch (this.sampleRate) {
      case 125:
        return 8;
      case 250:
        return 4;
      case 500:
        return 2;
      default:
        return 8;
    }
  }

  selectSource(source: BusSource): void {
    this.selectedSource = source;
    this.emitChannelSelection();
  }

  onSampleRateChange(value: string | number): void {
    const rate = Number(value);
    if (rate !== 125 && rate !== 250 && rate !== 500) {
      return;
    }
    this.sampleRate = rate;
    this.emitChannelSelection();
  }

  toggleChannel(channel: Channel, checked: boolean): void {
    channel.checked = checked;
    this.emitChannelSelection();
  }

  updateChannelName(channel: Channel, name: string): void {
    channel.name = name;
    this.emitChannelSelection();
  }

  /** Checked visible channels; plot view defaults to CH1 when this is empty. */
  getSelectedChannels(): Channel[] {
    return this.visibleChannels.filter(channel => channel.checked);
  }

  getSelectedChannelNames(): string[] {
    return defaultChannelWhenEmpty(this.getSelectedChannels()).map(channel => channel.name);
  }

  private emitChannelSelection(): void {
    const payload: ChannelSelection = {
      source: this.selectedSource,
      sampleRate: this.sampleRate,
      channels: this.getSelectedChannels()
    };
    this.channelSelectionChanged.emit(payload);
    this.plotBridge.publish(payload);
  }

  onRun(): void {
    this.emitChannelSelection();
  }
}
