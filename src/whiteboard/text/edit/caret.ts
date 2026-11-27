import type { CaretIndex, CaretPosition, CaretStop } from '../paint';

export function moveCaret(index: CaretIndex, position: CaretPosition, direction: 'left' | 'right' | 'up' | 'down' | 'line-start' | 'line-end', goalX?: number): CaretStop {
    if (index.navigate) return index.navigate(position, direction, goalX);
    const current = index.caret(position);
    const line = index.lines[current.line];
    if (direction === 'line-start') return line.stops[0] ?? current;
    if (direction === 'line-end') return line.stops[line.stops.length - 1] ?? current;
    if (direction === 'up' || direction === 'down') {
        const target = index.lines[current.line + (direction === 'up' ? -1 : 1)];
        if (!target?.stops.length) return current;
        const x = goalX ?? current.x;
        return target.stops.reduce((best, stop) => Math.abs(stop.x - x) < Math.abs(best.x - x) ? stop : best);
    }
    const step = direction === 'left' ? -1 : 1;
    let n = line.stops.findIndex(stop => stop.offset === current.offset && stop.affinity === current.affinity && stop.x === current.x);
    if (n < 0) return current;
    n += step;
    while (line.stops[n] && Math.abs(line.stops[n].x - current.x) < 0.001) n += step;
    if (line.stops[n]) return line.stops[n];
    const adjacent = index.lines[current.line + step]?.stops;
    return adjacent?.[step < 0 ? adjacent.length - 1 : 0] ?? current;
}
