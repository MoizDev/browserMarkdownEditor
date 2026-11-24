// All inference is over independent sessions, never over frames pooled across sessions.
const sorted = values => [...values].sort((a, b) => a - b);
function numbers(values) {
    if (!values.length || values.some(x => !Number.isFinite(x))) throw new Error('Expected finite session values');
    return sorted(values);
}
export function percentile(values, p) {
    if (!(p > 0 && p <= 1)) throw new Error('Percentile must be in (0, 1]');
    const xs = numbers(values);
    // Hyndman & Fan (1996), sample quantiles type 1: inverse empirical CDF.
    return xs[Math.ceil(p * xs.length) - 1];
}
export function median(values) {
    const xs = numbers(values), n = xs.length;
    return (xs[Math.floor((n - 1) / 2)] + xs[Math.floor(n / 2)]) / 2;
}
function binomial(n, p) {
    // Binomial recurrence P(K=k+1)/P(K=k)=(n-k)p/((k+1)(1-p)).
    const probabilities = [(1 - p) ** n];
    for (let k = 0; k < n; k++) probabilities.push(probabilities[k] * (n - k) * p / ((k + 1) * (1 - p)));
    return probabilities;
}
export function quantileInterval(values, p = 0.5, alpha = 0.05) {
    const xs = numbers(values), mass = binomial(xs.length, p);
    // David & Nagaraja, Order Statistics (3rd ed.), §7.1: binomial inversion.
    // X_(l) <= q_p <= X_(u); tails P(K<l), P(K>=u) <= alpha/2.
    // Index 0 and n+1 mean infinite bounds, NOT the sample extrema.
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
    // Mann & Whitney (1947), Ann. Math. Stat. 18, 50–60, U recurrence:
    // count(m,n,u) = count(m-1,n,u-n) + count(m,n-1,u).
    // BigInt keeps the exact null distribution (choose(80,40) exceeds 2^53).
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
    // Hodges & Lehmann (1963), Ann. Math. Stat. 34, 598–611: median pairwise
    // differences; Hollander/Wolfe/Chicken, Nonparametric Statistical Methods,
    // two-sample location problem: invert exact Wilcoxon rank-sum tails.
    // This distribution-free CI assumes independent, common-shape location arms
    // (multiplicative location on log scale for relative change). Ties widen it
    // conservatively: never use a tie-corrected normal approximation here.
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
    // Floor 10, grow by four, cap 40. Percentile gates require >=14 (§8.2).
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
    // Bonferroni over the predeclared looks protects 95% coverage when stopping
    // on interval width (ordinary fixed-n 95% intervals do NOT cover optional stopping).
    const alpha = 0.05 / looks;
    const rawInterval = metric.rule === 'target'
        ? quantileInterval(b, metric.percentile ? 0.8 : 0.5, alpha)
        : shiftInterval(a, b, { alpha, relative: metric.comparison === 'relative' });
    // Report an improvement as positive, so its LOWER bound must exceed zero
    // (§8.2). Retain the original B−A interval for independent re-derivation.
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
    // vr-lead ruling (§8.2): q80 is for TARGETS. Comparisons use HL of one
    // percentile per session. Loss: this tests the typical session's p95 shift,
    // not a shift in the worst-fifth tail; that would need a separate contract.
    return { counts: { A: a.length, B: b.length }, sessionValues: { A: a, B: b },
        medians: { A: median(a), B: median(b) }, interval, rawInterval, halfWidth,
        requiredHalfWidth: metric.threshold / 3, precise,
        status: precise ? passes ? 'pass' : 'fail' : 'inconclusive',
        inference: `Simultaneous >=95% coverage across ${looks} planned looks (Bonferroni).`,
        percentileRule: metric.percentile ? metric.rule === 'target'
            ? 'q80 of per-session percentiles, with exact order-statistic confidence bounds'
            : 'HL of per-session percentiles; typical-session shift, NOT worst-fifth-tail comparison' : null };
}
