export interface Point {
  x: number;
  y: number;
}

export interface PacketBus {
  StartTime: number;
  EndTime: number;
  Content: string;
}

export interface PlotTrack {
  id: string;
  name: string;
  subtitle: string;
  color: string;
  kind: 'bus' | 'channel';
}

export interface BusPolygon {
  center: Point;
  path: string;
  content: string;
  startTime: number;
  endTime: number;
}

export type PlotTool =
  | 'snapshot'
  | 'expand'
  | 'select'
  | 'zoomIn'
  | 'zoomOut'
  | 'pan'
  | 'fit'
  | 'move'
  | 'cursor'
  | 'grid'
  | 'flag';
