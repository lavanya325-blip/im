export type SampleRate = 125 | 250 | 500;
export type BusSource = 'Bus A' | 'Bus B';

export interface Channel {
  id: string;
  name: string;
  checked: boolean;
  color: string;
}

export interface ChannelSelection {
  source: BusSource;
  sampleRate: SampleRate;
  channels: Channel[];
}

export const BUS_CHANNEL_COLORS: Record<string, string> = {
  CH1: '#3FA9F5',
  CH2: '#0B68AB',
  CH3: '#FF931E',
  CH4: '#FF7BAC',
  CH5: '#F1CC2A',
  CH6: '#BD51F3',
  CH7: '#3BE5FF',
  CH8: '#78FF3B'
};

export function channelIdToNumber(id: string): number {
  const match = /^CH(\d+)$/i.exec(id.trim());
  return match ? Number(match[1]) : NaN;
}

export interface PlotTrack {
  id: string;
  name: string;
  subtitle: string;
  color: string;
  kind: 'bus' | 'channel';
}

export function defaultChannelWhenEmpty(channels: Channel[]): Channel[] {
  if (channels.length > 0) {
    return channels;
  }
  return [
    {
      id: 'CH1',
      name: 'CH1',
      checked: true,
      color: BUS_CHANNEL_COLORS.CH1
    }
  ];
}
