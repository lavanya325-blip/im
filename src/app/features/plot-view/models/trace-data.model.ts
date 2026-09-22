import { PacketBus } from './plot-track.model';

export interface EdgeCollection {
  firstEdgeRise: boolean;
  edges: number[];
}

export interface TraceData {
  minEdgeWidth: number;
  referenceTime: number;
  startTime: number;
  endTime: number;
  channels: Record<string, EdgeCollection>;
  buses: Record<string, PacketBus[]>;
}
