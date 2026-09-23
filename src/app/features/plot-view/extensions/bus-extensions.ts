import * as d3 from 'd3';
import { PacketBus, Point } from '../models/plot-track.model';

export class BusExtensions {
  static getPolygon(
    busData: PacketBus,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>
  ): string {
    const y1 = yScale(1);
    const y2 = yScale(0);
    const yc = yScale(0.5);
    const x1 = xScale(busData.StartTime);
    const x2 = xScale(busData.EndTime);
    const width = x2 - x1;

    let polygonPoints: [number, number][];
    if (width > 10) {
      const xOffset = 5;
      polygonPoints = [
        [x1, yc],
        [x1 + xOffset, y1],
        [x2 - xOffset, y1],
        [x2, yc],
        [x2 - xOffset, y2],
        [x1 + xOffset, y2]
      ];
    } else if (width >= 2) {
      const xOffset = 0.5;
      polygonPoints = [
        [x1, yc],
        [x1 + xOffset, y1],
        [x2 - xOffset, y1],
        [x2, yc],
        [x2 - xOffset, y2],
        [x1 + xOffset, y2]
      ];
    } else {
      polygonPoints = [
        [x1, y1],
        [x2, y1],
        [x2, y2],
        [x1, y2]
      ];
    }

    return polygonPoints.map(p => p.join(',')).join(' ');
  }

  static getPolygonCenter(
    polygon: PacketBus,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>
  ): Point {
    return {
      x: xScale(0.5 * (polygon.StartTime + polygon.EndTime)),
      y: yScale(0.5)
    };
  }
}
