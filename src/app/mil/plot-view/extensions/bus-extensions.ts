import * as d3 from 'd3';
import * as DecoderTypes_pb from '../../../../protos/DecoderTypes';
import { Point } from '../models/plot-track.model';

export class BusExtensions {
  static getPolygon(
    packet: DecoderTypes_pb.PacketBus,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>
  ): string {
    const x1 = xScale(packet.StartTime);
    const x2 = xScale(packet.EndTime);
    const yTop = yScale(1);
    const yBottom = yScale(0);
    return `${x1},${yTop} ${x2},${yTop} ${x2},${yBottom} ${x1},${yBottom}`;
  }

  static getPolygonCenter(
    packet: DecoderTypes_pb.PacketBus,
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>
  ): Point {
    return {
      x: (xScale(packet.StartTime) + xScale(packet.EndTime)) / 2,
      y: yScale(0.5)
    };
  }

  static getPolygonStyleName(packet: DecoderTypes_pb.PacketBus): string {
    return packet.Content ?? '';
  }
}
