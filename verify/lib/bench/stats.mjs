const sorted = values => [...values].sort((a, b) => a - b);
function numbers(values) {
    if (!values.length || values.some(x => !Number.isFinite(x))) throw new Error('Expected finite session values');
    return sorted(values);
}
export function percentile(values, p) {
    if (!(p > 0 && p <= 1)) throw new Error('Percentile must be in (0, 1]');
    const xs = numbers(values);
    return xs[Math.ceil(p * xs.length) - 1];
}
export function median(values) {
    const xs = numbers(values), n = xs.length;
    return (xs[Math.floor((n - 1) / 2)] + xs[Math.floor(n / 2)]) / 2;
}
function binomial(n, p) {
    const probabilities = [(1 - p) ** n];
    for (let k = 0; k < n; k++) probabilities.push(probabilities[k] * (n - k) * p / ((k + 1) * (1 - p)));
    return probabilities;
}
export function quantileInterval(values, p = 0.5, alpha = 0.05) {
    const xs = numbers(values), mass = binomial(xs.length, p);
    let lowerRank = 0, upperRank = xs.length + 1, sum = 0;
    for (let k = 0; k <= xs.length; k++) {
        sum += mass[k];
        if (sum <= alpha / 2) lowerRank = k + 1;
    }
    sum = 0;
    for (let k = xs.length; k >= 0; k--) {
        sum += mass[k];
        if (sum <= alpha / 2) upperRank = k;
    }
    return { estimate: p === 0.5 ? median(xs) : percentile(xs, p),
        lower: lowerRank === 0 ? -Infinity : xs[lowerRank - 1],
        upper: upperRank > xs.length ? Infinity : xs[upperRank - 1],
        lowerRank, upperRank, alpha, quantile: p };
}
const uCache = new Map();
function mannWhitneyMass(m, n) {
    const key = `${m}/${n}`;
    if (uCache.has(key)) return uCache.get(key);
    let previous = Array.from({ length: n + 1 }, () => [1n]);
    for (let i = 1; i <= m; i++) {
        const row = [[1n]];
        for (let j = 1; j <= n; j++) {
            row[j] = Array.from({ length: i * j + 1 }, (_, u) =>
                (previous[j][u - j] ?? 0n) + (row[j - 1][u] ?? 0n));
        }
        previous = row;
    }
    const counts = previous[n], total = counts.reduce((a, b) => a + b, 0n);
    const result = counts.map(x => Number(x) / Number(total));
    uCache.set(key, result);
    return result;
}
export function shiftInterval(a, b, { alpha = 0.05, relative = false } = {}) {
    numbers(a); numbers(b);
    if (relative && [...a, ...b].some(x => x <= 0)) throw new Error('Relative metrics require positive values');
    const transform = relative ? Math.log : x => x;
    const differences = sorted(b.flatMap(y => a.map(x => transform(y) - transform(x))));
    const mass = mannWhitneyMass(a.length, b.length);
    let cdf = 0, excluded = 0;
    for (let u = 0; u < mass.length; u++) {
        cdf += mass[u];
        if (cdf <= alpha / 2) excluded = u + 1;
        else break;
    }
    const inverse = relative ? x => Math.expm1(x) : x => x;
    return { estimate: inverse(median(differences)),
        lower: excluded === 0 ? -Infinity : inverse(differences[excluded - 1]),
        upper: excluded === 0 ? Infinity : inverse(differences[differences.length - excluded]),
        alpha, excluded, pairs: differences.length, scale: relative ? 'relative (log location)' : 'absolute',
        assumption: 'Independent sessions; arms differ by a common-shape location shift on the stated scale.' };
}
export function sessionSchedule(percentileTarget = false) {
    const counts = [];
    for (let n = percentileTarget ? 14 : 10; n < 40; n += 4) counts.push(n);
    return [...counts, 40];
}
export function summarize(arms, metric, { looks = sessionSchedule(Boolean(metric.percentile)).length } = {}) {
    const { A, B } = arms;
    const perSession = arm => arm.map(record => {
        if (!metric.percentile && record.values.length !== 1) throw new Error('A scalar session must contribute exactly one value');
        return metric.percentile ? percentile(record.values, metric.percentile) : record.values[0];
    });
    const a = perSession(A), b = perSession(B);
    const alpha = 0.05 / looks;
    const rawInterval = metric.rule === 'target'
        ? quantileInterval(b, metric.percentile ? 0.8 : 0.5, alpha)
        : shiftInterval(a, b, { alpha, relative: metric.comparison === 'relative' });
    const interval = metric.rule === 'improvement' && metric.lowerIsBetter !== false
        ? { ...rawInterval, estimate: -rawInterval.estimate, lower: -rawInterval.upper, upper: -rawInterval.lower }
        : rawInterval;
    const halfWidth = (interval.upper - interval.lower) / 2;
    const precise = Number.isFinite(halfWidth) && halfWidth <= metric.threshold / 3;
    let passes;
    if (metric.rule === 'target') passes = interval.upper <= metric.target;
    else if (metric.rule === 'no-regression') {
        passes = metric.lowerIsBetter !== false ? interval.upper < metric.threshold : interval.lower > -metric.threshold;
    } else if (metric.rule === 'improvement') {
        passes = interval.lower > 0;
    } else throw new Error(`Unknown pass rule: ${metric.rule}`);
    return { counts: { A: a.length, B: b.length }, sessionValues: { A: a, B: b },
        medians: { A: median(a), B: median(b) }, interval, rawInterval, halfWidth,
        requiredHalfWidth: metric.threshold / 3, precise,
        status: precise ? passes ? 'pass' : 'fail' : 'inconclusive',
        inference: `Simultaneous >=95% coverage across ${looks} planned looks (Bonferroni).`,
        percentileRule: metric.percentile ? metric.rule === 'target'
            ? 'q80 of per-session percentiles, with exact order-statistic confidence bounds'
            : 'HL of per-session percentiles; typical-session shift, NOT worst-fifth-tail comparison' : null };
}
