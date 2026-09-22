import { PacketBus, Point } from '../models/plot-track.model';

type LinearScale = { (value: number): number };

export class BusExtensions {
  static getPolygon(
    packet: PacketBus,
    xScale: LinearScale,
    yScale: LinearScale
  ): string {
    const x1 = xScale(packet.StartTime);
    const x2 = xScale(packet.EndTime);
    const yTop = yScale(1);
    const yBottom = yScale(0);
    const height = Math.abs(yBottom - yTop);
    const width = Math.max(0, x2 - x1);
    const notch = Math.min(height / 2, width / 4);
    const yMid = (yTop + yBottom) / 2;

    return [
      `${x1},${yMid}`,
      `${x1 + notch},${yTop}`,
      `${x2 - notch},${yTop}`,
      `${x2},${yMid}`,
      `${x2 - notch},${yBottom}`,
      `${x1 + notch},${yBottom}`
    ].join(' ');
  }

  static getPolygonCenter(
    packet: PacketBus,
    xScale: LinearScale,
    yScale: LinearScale
  ): Point {
    return {
      x: (xScale(packet.StartTime) + xScale(packet.EndTime)) / 2,
      y: (yScale(0) + yScale(1)) / 2
    };
  }

  static getPolygonText(
    textElement: HTMLElement,
    content: string,
    availableWidth: number
  ): string {
    const font = window.getComputedStyle(textElement).font || '9px sans-serif';
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return content;
    }
    ctx.font = font;
    if (ctx.measureText(content).width <= availableWidth) {
      return content;
    }
    if (availableWidth < 8) {
      return '';
    }
    let truncated = content;
    while (truncated.length > 0 && ctx.measureText(`${truncated}…`).width > availableWidth) {
      truncated = truncated.slice(0, -1);
    }
    return truncated.length ? `${truncated}…` : '';
  }
}
