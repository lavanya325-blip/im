import * as d3 from 'd3';
import { Point } from '../models/plot-track.model';

const bisector = d3.bisector((d: Point) => d.x);

export function toRawPoints(firstEdgeRise: boolean, edges: number[]): Point[] {
  const points: Point[] = [];
  for (let index = 0; index < edges.length; index++) {
    points.push({
      x: edges[index],
      y: index % 2 === (firstEdgeRise ? 0 : 1) ? 1 : 0
    });
  }
  return points;
}

/**
 * Slice a step-after waveform to the padded visible window, matching I3C plot-view.
 * Extends the first/last level so the line does not disappear at the viewport edge.
 */
export function toPoints(
  waveform: Point[],
  visibleStart: number,
  visibleStop: number,
  fullDomain: [number, number]
): Point[] {
  if (!waveform.length) {
    return [];
  }

  const [dataStart, dataEnd] = fullDomain;
  const startIndex = Math.max(0, bisector.right(waveform, visibleStart) - 1);
  const endIndex = Math.min(waveform.length, bisector.left(waveform, visibleStop) + 1);
  const points = waveform.slice(startIndex, endIndex).map(point => ({ x: point.x, y: point.y }));

  if (!points.length) {
    return [];
  }

  if (points[0].x > visibleStart) {
    points.unshift({
      x: Math.max(dataStart, visibleStart),
      y: points[0].y
    });
  }

  const last = points[points.length - 1];
  if (last.x < visibleStop) {
    points.push({
      x: Math.min(dataEnd, visibleStop),
      y: last.y
    });
  }

  return points;
}

export function toEngineeringTime(seconds: number): string {
  const abs = Math.abs(seconds);
  const sign = seconds < 0 ? '-' : '';

  if (abs === 0) {
    return '0 s';
  }
  if (abs < 1e-6) {
    return `${sign}${(abs * 1e9).toFixed(2)} ns`;
  }
  if (abs < 1e-3) {
    return `${sign}${(abs * 1e6).toFixed(2)} µs`;
  }
  if (abs < 1) {
    return `${sign}${(abs * 1e3).toFixed(2)} ms`;
  }
  return `${sign}${abs.toFixed(3)} s`;
}
