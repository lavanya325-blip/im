import { PacketBus } from './plot-track.model';


export interface EdgeCollection {
  firstEdgeRise: boolean;
  edges: number[];
}


export interface TraceData {
  referenceTime: number;
  startTime: number;
  endTime: number;
  minEdgeWidth: number;
  channels: Record<string, EdgeCollection>;
  buses: Record<string, PacketBus[]>;
}


export function createSampleTrace(): TraceData | null {
  return null;
}
