import * as d3 from 'd3';
import { Point } from '../models/plot-track.model';

const bisector = d3.bisector((d: Point) => d.x);

export function toPoints(
  edges: Point[],
  visibleStart: number,
  visibleStop: number,
  fullDomain: [number, number]
): Point[] {
  const [begin] = fullDomain;
  const startIndex = bisector.left(edges, visibleStart);
  const endIndex = bisector.right(edges, visibleStop);

  let prevState =
    startIndex <= 0
      ? (edges.length > 0 ? edges[0].y : 1)
      : ((startIndex < edges.length ? edges[startIndex - 1].y : edges[edges.length - 1].y) === 0 ? 1 : 0);

  if (visibleStart > begin) {
    prevState = prevState === 0 ? 1 : 0;
  }

  const points: Point[] = [];
  let prevPoint: Point = { x: visibleStart, y: prevState };
  points.push(prevPoint);

  for (let index = startIndex; index < endIndex; index++) {
    const currentPoint = edges[index];
    points.push({ x: currentPoint.x, y: prevPoint.y });
    points.push({ x: currentPoint.x, y: currentPoint.y });
    prevPoint = currentPoint;
  }

  points.push({ x: visibleStop, y: prevPoint.y });
  return points;
}

export function getWaveformState(firstEdge: boolean, index: number): number {
  return index % 2 === (firstEdge ? 0 : 1) ? 1 : 0;
}

export function toRawPoints(firstEdge: boolean, edges: number[]): Point[] {
  const points: Point[] = [];
  for (let index = 0; index < edges.length; index++) {
    points.push({ x: edges[index], y: getWaveformState(firstEdge, index) });
  }
  return points;
}

export function toEngineeringTime(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs >= 1e-3) {
    return `${(seconds * 1e3).toFixed(3)} ms`;
  }
  return `${(seconds * 1e6).toFixed(3)} µs`;
}
