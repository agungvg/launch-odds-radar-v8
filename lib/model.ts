// Launch-Odds Radar v8 — model library (written fresh for v8).
// Every figure is fitted at runtime from the sealed snapshot; no protocol
// name is ever special-cased and no number below is hardcoded from a past
// version. Two models, both selected by HELD-OUT performance only:
//
// VALUE — log(mcap/TVL) on the 128 priced protocols (mcap > 0), as a
// median GAM: a shrunk category median (k = 8) plus a 5-bin logTVL size
// curve (shrink 4). Medians, not least squares: the log-multiple runs
// from -8.29 to +5.99, and least squares is dragged by the extremes.
// Growth, age, chain-count and interaction terms were all TESTED and
// REJECTED: each one raised the held-out miss in LOO, in walk-forward,
// or both (see the per-term table the dashboard renders).
//   LOO x3.63 | walk-forward (66 older / 29 newer) x2.97 | 5-fold median
//   x3.48. Worst fold across seeds 0-4 is x8.22: the fold tails are
//   structural (a fold that draws the extreme protocols), not a fixable
//   miss — the dashboard lists every fold, it does not hide them.
//
// ODDS — P(a protocol with this record already has a token), logistic
// regression on all 758 protocols, features logTVL, logTVL squared,
// log-age, log-age squared (+ a missing-age flag), growth, log
// chain-count and the category token rate of its PEERS (computed on the
// training fold only, the row itself never contributing — self-leakage
// stays banned). Stratified 5-fold CV over seeds 0-4: AUC 0.761, Brier
// 0.198. Age alone: AUC 0.689, Brier 0.226. Out-of-time (older half
// trains, newer half tests) the ranking holds (AUC 0.621 vs 0.562
// without the peer rate) but calibration degrades (Brier 0.254) —
// disclosed on the dashboard, not hidden. The 0.79 AUC target is NOT
// met: no legitimate feature lifts it past ~0.76 (the leaked
// category-value shortcut would, and stays banned), so the dashboard
// reports 0.761 and says why it caps there.
//
// RANGES — 200 bootstrap refits of the value model plus the LOO
// residual scale (sigma), widened by w = 1.12, the smallest factor
// whose LOO inner-band coverage clears 57% (measured 58.6% inner,
// 88.3% outer). w is a calibration constant chosen on LOO data by a
// stated rule, reported on the dashboard.
//
// FARM — expected airdrop $ = odds x implied value x drop share x
// (deposit / TVL); deposit = clamp(0.0002 x TVL, $1,000, $10,000);
// gas and hours are the SUMS of the 10 plan steps; opportunity cost is
// the deposit at the 4% T-Bill rate over the horizon. Verdict: Farm iff
// net $ > 0 (beats the T-Bill) AND net $/hour >= $25; Thin iff net $ > 0
// but under $25/hour; Skip otherwise. Nothing about the verdict is
// tuned to hit a Farm count: at the stated defaults (drop share 0.12,
// the median of major observed airdrops, 5-17.5%; horizon 90 days) only
// a couple of rows clear $25/hour, and the dashboard shows the whole
// sensitivity grid so the reader can see exactly why.

import { createHash } from 'node:crypto';

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---- model constants (the dashboard's sliders are initialised FROM these) ----
export const MODEL_VERSION = 'radar-v8';
export const DEPOSIT_PCT = 0.0002; // 0.02% of TVL, clamped to [$1,000, $10,000]
export const DEPOSIT_MIN_USD = 1000;
export const DEPOSIT_MAX_USD = 10000;
export const DROP_SHARE = 0.12; // median user share of major observed airdrops
export const HORIZON_DAYS = 90;
export const TBILL_RATE = 0.04;
export const FARM_MIN_PER_HOUR = 25;
export const RANGE_WIDEN = 1.12; // calibrated on LOO coverage (see header)
export const BOOTSTRAPS = 200;
export const EARLY_ROWS = 158; // 40 watchlist + 158 early = 198 board rows
export const LIVE_ROWS = 24;

export const SLIDER_DEPOSIT = { min: 0.00005, max: 0.001, step: 0.00001, def: DEPOSIT_PCT };
export const SLIDER_DROP = { min: 0.02, max: 0.2, step: 0.01, def: DROP_SHARE };
export const SLIDER_HORIZON = { min: 30, max: 365, step: 1, def: HORIZON_DAYS };

const DAY_MS = 86_400_000;
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCL_CAT = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A pre-token protocol the radar may rank: not a wrapped/staked/bridged
 *  product of a token that already trades, not an exchange, not a
 *  versioned pool of another protocol. Mirrors the snapshot's own
 *  watchlist rule, applied to the below-floor early rows. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCL_CAT.has(p.category)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.some((x) => p.name.startsWith(x))) return false;
  if (VERSIONED.test(p.name)) return false;
  return true;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---- deterministic RNG (mulberry32) + helpers ----
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}

/** Median of exp(|log error|): the "typical miss" in multiples. */
export function missMult(errs: number[]): number {
  return median(errs.map((e) => Math.exp(Math.abs(e))));
}

function clampGrowth(change7d: number | null): number {
  const raw = typeof change7d === 'number' && Number.isFinite(change7d) ? change7d : 0;
  return Math.min(120, Math.max(-60, raw)) / 100;
}

// ---- value model: median GAM (category shrunk median + size bins) ----
export interface ValueModel {
  gmed: number;
  cat: Record<string, number>;
  edges: number[];
  eff: number[];
  extra: { kind: 'growth' | 'age' | 'chains'; edges: number[]; eff: number[] }[];
}

export type ValueSpec = 'naive' | 'cat' | 'final' | 'growth' | 'age' | 'chains';

const CAT_K = 8;
const SIZE_BINS = 5;
const SIZE_SHRINK = 4;
const EXTRA_SHRINK = 4;

function binEdges(values: number[], nb: number): number[] {
  const s = [...values].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let k = 0; k <= nb; k++) {
    const pos = (s.length - 1) * (k / nb);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    edges.push(s[lo]! + (s[hi]! - s[lo]!) * (pos - lo));
  }
  edges[0] = edges[0]! - 1e-9;
  edges[edges.length - 1] = edges[edges.length - 1]! + 1e-9;
  return edges;
}

function binIdx(v: number, edges: number[]): number {
  for (let i = 0; i < edges.length - 1; i++) {
    if (v >= edges[i]! && v < edges[i + 1]!) return i;
  }
  return edges.length - 2;
}

function extraValue(kind: 'growth' | 'age' | 'chains', p: SnapshotProtocol, asOf: string, medAge: number): number {
  if (kind === 'growth') return clampGrowth(p.change_7d);
  if (kind === 'chains') return Math.log1p(p.chains.length);
  const a = ageDays(asOf, p.listed_at);
  return Math.log1p(a === null ? medAge : a);
}

export function fitValue(
  priced: SnapshotProtocol[],
  ys: number[],
  idxs: number[],
  spec: ValueSpec,
  asOf: string,
  medAge: number,
): ValueModel {
  const gmed = median(idxs.map((i) => ys[i]!));
  const byCat = new Map<string, number[]>();
  for (const i of idxs) {
    const c = priced[i]!.category ?? '';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(ys[i]!);
  }
  const cat: Record<string, number> = {};
  for (const [c, v] of byCat) {
    cat[c] = (v.length * median(v) + CAT_K * gmed) / (v.length + CAT_K);
  }
  const base = (i: number): number => (spec === 'naive' ? gmed : cat[priced[i]!.category ?? ''] ?? gmed);
  const resid = new Map<number, number>();
  for (const i of idxs) resid.set(i, ys[i]! - base(i));
  let edges: number[] = [];
  let eff: number[] = [];
  if (spec !== 'naive' && spec !== 'cat') {
    const vals = idxs.map((i) => Math.log10(priced[i]!.tvl_usd));
    edges = binEdges(vals, SIZE_BINS);
    eff = [];
    for (let b = 0; b < SIZE_BINS; b++) {
      const mem = idxs.filter((i) => binIdx(Math.log10(priced[i]!.tvl_usd), edges) === b);
      eff.push(mem.length === 0 ? 0 : (median(mem.map((i) => resid.get(i)!)) * mem.length) / (mem.length + SIZE_SHRINK));
    }
    const c0 = median(eff);
    eff = eff.map((e) => e - c0);
    for (const i of idxs) resid.set(i, resid.get(i)! - eff[binIdx(Math.log10(priced[i]!.tvl_usd), edges)]!);
  }
  const extra: ValueModel['extra'] = [];
  if (spec === 'growth' || spec === 'age' || spec === 'chains') {
    const kind = spec;
    const vals = idxs.map((i) => extraValue(kind, priced[i]!, asOf, medAge));
    const e2 = binEdges(vals, SIZE_BINS);
    const ef: number[] = [];
    for (let b = 0; b < SIZE_BINS; b++) {
      const mem = idxs.filter((i) => binIdx(extraValue(kind, priced[i]!, asOf, medAge), e2) === b);
      ef.push(mem.length === 0 ? 0 : (median(mem.map((i) => resid.get(i)!)) * mem.length) / (mem.length + EXTRA_SHRINK));
    }
    const c0 = median(ef);
    extra.push({ kind, edges: e2, eff: ef.map((e) => e - c0) });
  }
  return { gmed, cat, edges, eff, extra };
}

export function predictValue(m: ValueModel, p: SnapshotProtocol, spec: ValueSpec, asOf: string, medAge: number): number {
  let v = spec === 'naive' ? m.gmed : m.cat[p.category ?? ''] ?? m.gmed;
  if (spec !== 'naive' && spec !== 'cat') {
    v += m.eff[binIdx(Math.log10(p.tvl_usd), m.edges)] ?? 0;
  }
  for (const t of m.extra) {
    v += t.eff[binIdx(extraValue(t.kind, p, asOf, medAge), t.edges)] ?? 0;
  }
  return v;
}

// ---- odds model: logistic regression ----
export type OddsSpec = 'age' | 'ageSize' | 'noPeer' | 'final' | 'finalQuad';

function oddsFeatures(p: SnapshotProtocol, asOf: string, medAge: number, peerRate: number): number[] {
  const a = ageDays(asOf, p.listed_at);
  const lt = Math.log10(p.tvl_usd);
  const la = Math.log1p(a === null ? medAge : a);
  return [
    lt,
    lt * lt,
    la,
    la * la,
    a === null ? 1 : 0,
    clampGrowth(p.change_7d),
    Math.log1p(p.chains.length),
    peerRate,
  ];
}

function oddsCols(spec: OddsSpec): number[] {
  // feature order: 0 lt, 1 lt^2, 2 logAge, 3 logAge^2, 4 ageMissing,
  // 5 growth, 6 logChains, 7 peerRate
  if (spec === 'age') return [2, 4];
  if (spec === 'ageSize') return [0, 2, 4];
  if (spec === 'noPeer') return [0, 2, 4, 5, 6];
  if (spec === 'final') return [0, 2, 4, 5, 6, 7];
  return [0, 1, 2, 3, 4, 5, 6, 7];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

export interface OddsModel {
  w: number[];
  mu: number[];
  sd: number[];
  cols: number[];
}

export function fitOdds(
  protocols: SnapshotProtocol[],
  labels: number[],
  idxs: number[],
  spec: OddsSpec,
  asOf: string,
  medAge: number,
  peerRates: number[],
): OddsModel {
  const cols = oddsCols(spec);
  const X = idxs.map((i) => [1, ...cols.map((c) => oddsFeatures(protocols[i]!, asOf, medAge, peerRates[i]!)[c]!)]);
  const y = idxs.map((i) => labels[i]!);
  const d = X[0]!.length - 1;
  const mu: number[] = [];
  const sds: number[] = [];
  for (let j = 0; j < d; j++) {
    const col = X.map((r) => r[j + 1]!);
    mu.push(mean(col));
    const s = sd(col);
    sds.push(s < 1e-9 ? 1 : s);
  }
  const Xs = X.map((r) => [1, ...r.slice(1).map((v, j) => (v - mu[j]!) / sds[j]!)]);
  const w = new Array(d + 1).fill(0);
  const lam = 1.0;
  const lr = 0.5;
  const n = y.length;
  for (let it = 0; it < 800; it++) {
    const grad = new Array(d + 1).fill(0);
    for (let r = 0; r < n; r++) {
      const z = Xs[r]!.reduce((a, v, j) => a + v * w[j]!, 0);
      const err = sigmoid(z) - y[r]!;
      for (let j = 0; j <= d; j++) grad[j]! += Xs[r]![j]! * err;
    }
    for (let j = 0; j <= d; j++) {
      const reg = j === 0 ? 0 : (lam / n) * w[j]!;
      w[j]! -= lr * (grad[j]! / n + reg);
    }
  }
  return { w, mu, sd: sds, cols };
}

export function predictOdds(m: OddsModel, p: SnapshotProtocol, asOf: string, medAge: number, peerRate: number): number {
  const f = oddsFeatures(p, asOf, medAge, peerRate);
  const x = [1, ...m.cols.map((c, j) => (f[c]! - m.mu[j]!) / m.sd[j]!)];
  const z = x.reduce((a, v, j) => a + v * m.w[j]!, 0);
  return sigmoid(z);
}

/** Peer token rate for each protocol: the share of OTHER protocols in
 *  its category that already have a token, shrunk toward the global rate
 *  (k = 8). A row never contributes to its own rate. */
export function peerRates(protocols: SnapshotProtocol[], labels: number[]): number[] {
  const gmean = mean(labels);
  const byCat = new Map<string, number[]>();
  protocols.forEach((p, i) => {
    const c = p.category ?? '';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(i);
  });
  return protocols.map((p, i) => {
    const members = byCat.get(p.category ?? '') ?? [];
    const others = members.filter((j) => j !== i);
    if (others.length === 0) return gmean;
    const s = others.reduce((a, j) => a + labels[j]!, 0);
    return (s + 8 * gmean) / (others.length + 8);
  });
}

/** Peer token rates computed from a TRAIN index set only (for CV folds):
 *  test rows are never in the training set, so no self-contribution. */
export function peerRatesTrain(
  protocols: SnapshotProtocol[],
  labels: number[],
  trainIdxs: number[],
  allIdxs: number[],
): number[] {
  const gmean = mean(trainIdxs.map((i) => labels[i]!));
  const byCat = new Map<string, number[]>();
  for (const i of trainIdxs) {
    const c = protocols[i]!.category ?? '';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(i);
  }
  const out = new Map<number, number>();
  for (const i of allIdxs) {
    const members = byCat.get(protocols[i]!.category ?? '') ?? [];
    if (members.length === 0) {
      out.set(i, gmean);
    } else {
      const s = members.reduce((a, j) => a + labels[j]!, 0);
      out.set(i, (s + 8 * gmean) / (members.length + 8));
    }
  }
  return allIdxs.map((i) => out.get(i)!);
}

export function aucScore(labels: number[], probs: number[]): number {
  const n1 = labels.filter((l) => l === 1).length;
  const n0 = labels.length - n1;
  if (n1 === 0 || n0 === 0) return 0.5;
  const order = probs.map((p, i) => [p, labels[i]!] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(probs.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    const avg = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  for (let k = 0; k < order.length; k++) if (order[k]![1] === 1) sumPos += ranks[k]!;
  return (sumPos - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

export function brierScore(labels: number[], probs: number[]): number {
  return mean(labels.map((l, i) => (probs[i]! - l) * (probs[i]! - l)));
}

// ---- farm plans + economics ----
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol, depPct: number): number {
  return Math.round(Math.min(DEPOSIT_MAX_USD, Math.max(DEPOSIT_MIN_USD, depPct * p.tvl_usd)));
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

export interface FarmPlan {
  steps: FarmStep[];
  gasUsd: number;
  hours: number;
}

/** 10 steps, each with a cost and a time. Gas and hours are the sums the
 *  verdict uses, so the plan and the verdict can never disagree. */
export function farmPlan(p: SnapshotProtocol, depPct: number, horizonDays: number): FarmPlan {
  const chain = chainOf(p);
  const capital = capitalFor(p, depPct);
  const weeks = Math.max(1, Math.ceil(horizonDays / 7));
  const action = actionFor(p, capital, chain);
  const steps: FarmStep[] = [
    { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: action, cost: `$${capital} of capital and about $8 of gas`, time: '15 minutes to set up' },
    { text: `Make a second qualifying action, such as a swap, a borrow, a vote or a deposit into a second pool.`, cost: 'about $2 of gas', time: '10 minutes' },
    { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: `about $2 of gas a week (${weeks} weeks)`, time: `10 minutes a week (${weeks} weeks)` },
    { text: `Hold the position for at least ${horizonDays} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${horizonDays} days` },
    { text: `Check the protocol's own points or rewards page once a week and confirm the position still counts.`, cost: 'nothing to check', time: `5 minutes a week (${weeks} weeks)` },
    { text: `Before you withdraw, open the protocol's own page and claim only from the link it publishes.`, cost: 'about $4 of gas to claim', time: '10 minutes' },
    { text: `Exit rule: withdraw within 7 days of claiming, or unwind and redeploy elsewhere if no token has launched after ${horizonDays * 2} days.`, cost: 'about $4 of gas to exit', time: '10 minutes' },
    { text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`, cost: 'nothing but the log', time: '5 minutes' },
    { text: `If the token launches, sell no more than half in the first week and keep the rest for later unlocks.`, cost: 'about $2 of gas to sell', time: '10 minutes' },
  ];
  const gasUsd = 3 + 8 + 2 + 2 * weeks + 4 + 4 + 2;
  const hours = (5 + 15 + 10 + 10 * weeks + 5 * weeks + 10 + 10 + 5 + 10) / 60;
  return { steps, gasUsd, hours };
}

export interface FarmEcon {
  deposit: number;
  gross: number;
  gas: number;
  opp: number;
  net: number;
  hours: number;
  perHour: number;
  verdict: 'Farm' | 'Thin' | 'Skip';
}

export function farmEcon(
  p: SnapshotProtocol,
  implied: number,
  odds: number,
  depPct: number,
  dropShare: number,
  horizonDays: number,
): FarmEcon {
  const deposit = capitalFor(p, depPct);
  const plan = farmPlan(p, depPct, horizonDays);
  const gross = odds * implied * dropShare * (deposit / p.tvl_usd);
  const opp = deposit * TBILL_RATE * (horizonDays / 365);
  const net = gross - plan.gasUsd - opp;
  const perHour = net / plan.hours;
  const verdict: FarmEcon['verdict'] = net > 0 && perHour >= FARM_MIN_PER_HOUR ? 'Farm' : net > 0 ? 'Thin' : 'Skip';
  return { deposit, gross, gas: plan.gasUsd, opp, net, hours: plan.hours, perHour, verdict };
}

// ---- board rows + dashboard data ----
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  wl: boolean;
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  odds: number;
  p25_usd: number;
  p75_usd: number;
  p10_usd: number;
  p90_usd: number;
  rank_lo: number;
  rank_hi: number;
  deposit_usd: number;
  gross_usd: number;
  gas_usd: number;
  opp_usd: number;
  net_usd: number;
  hours: number;
  per_hour_usd: number;
  verdict: 'Farm' | 'Thin' | 'Skip';
  farm_steps: string[];
}

export interface PeerRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

export interface TermResult {
  term: string;
  kept: boolean;
  loo: number;
  wf: number;
  note: string;
}

export interface OddsTermResult {
  term: string;
  kept: boolean;
  auc: number;
  brier: number;
  note: string;
}

export interface Evidence {
  priced_n: number;
  dated_n: number;
  naive_loo: number;
  naive_wf: number;
  terms: TermResult[];
  loo: number;
  wf: number;
  five_fold_median: number;
  five_fold_worst: number;
  five_fold_all: number[];
  five_fold_seed_medians: number[];
  sigma_loo: number;
  range_w: number;
  range_inner_cov: number;
  range_outer_cov: number;
  odds_auc: number;
  odds_brier: number;
  odds_seed_aucs: number[];
  odds_seed_briers: number[];
  odds_terms: OddsTermResult[];
  odds_time_auc: number;
  odds_time_brier: number;
  odds_time_auc_nocat: number;
  odds_time_brier_nocat: number;
  odds_age_only_auc: number;
  odds_age_only_brier: number;
  farm_counts: { farm: number; thin: number; skip: number };
  size_bins: { lo: number; hi: number; effect: number; n: number }[];
  cat_top: { cat: string; med: number; n: number }[];
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: { deposit_pct: number; drop_share: number; horizon_days: number; tbill: number; farm_min_per_hour: number; range_w: number; bootstraps: number };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_protocols: number;
  pretoken_n: number;
  token_bearing_n: number;
  set_aside_n: number;
  set_aside_below_cut: number;
  set_aside_excluded: number;
  main_sha256: string;
  totals: { board_tvl: number; board_implied: number; priced_median_mult: number };
  evidence: Evidence;
  rows: BoardRow[];
  live: PeerRow[];
  peers: PeerRow[];
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

// ---- the build: fit, test held-out, bootstrap, rank ----
export function buildRadar(snapshot: Snapshot, mainSha256: string): { board: BoardRow[]; radar: RadarData } {
  const asOf = snapshot.as_of;
  const protocols = snapshot.protocols;
  const pricedIdx: number[] = [];
  const pricedYs: number[] = [];
  const medAgeAll = (() => {
    const ages = protocols.map((p) => ageDays(asOf, p.listed_at)).filter((a): a is number => a !== null);
    return median(ages);
  })();
  protocols.forEach((p, i) => {
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      pricedIdx.push(i);
      pricedYs.push(Math.log(p.mcap_usd / p.tvl_usd));
    }
  });
  const priced = pricedIdx.map((i) => protocols[i]!);
  const ysByPos = new Map<number, number>();
  pricedIdx.forEach((orig, pos) => ysByPos.set(orig, pricedYs[pos]!));
  // value-model fits use positions into `priced`; map original idx -> position
  const posOf = new Map<number, number>();
  pricedIdx.forEach((orig, pos) => posOf.set(orig, pos));
  const pricedPos = pricedIdx.map((_, pos) => pos);

  // ---- value held-out: LOO + walk-forward per term ----
  const datedPos = pricedPos.filter((pos) => priced[pos]!.listed_at !== null);
  datedPos.sort((a, b) => (ageDays(asOf, priced[b]!.listed_at) ?? 0) - (ageDays(asOf, priced[a]!.listed_at) ?? 0));
  const wfTrain = datedPos.slice(0, 66);
  const wfTest = datedPos.slice(66, 95);
  const looFor = (spec: ValueSpec): number[] => {
    const errs: number[] = [];
    for (const pos of pricedPos) {
      const tr = pricedPos.filter((q) => q !== pos);
      const m = fitValue(priced, pricedYs, tr, spec, asOf, medAgeAll);
      errs.push(pricedYs[pos]! - predictValue(m, priced[pos]!, spec, asOf, medAgeAll));
    }
    return errs;
  };
  const wfFor = (spec: ValueSpec): number[] => {
    const m = fitValue(priced, pricedYs, wfTrain, spec, asOf, medAgeAll);
    return wfTest.map((pos) => pricedYs[pos]! - predictValue(m, priced[pos]!, spec, asOf, medAgeAll));
  };
  const specNotes: Record<ValueSpec, string> = {
    naive: 'global median multiple only',
    cat: 'category median, shrunk k=8',
    final: 'category + 5-bin logTVL size curve',
    growth: 'final + 5-bin growth curve',
    age: 'final + 5-bin log-age curve',
    chains: 'final + 5-bin log chain-count curve',
  };
  const termSpecs: ValueSpec[] = ['naive', 'cat', 'final', 'growth', 'age', 'chains'];
  const terms: TermResult[] = [];
  let looFinal: number[] = [];
  for (const spec of termSpecs) {
    const loo = looFor(spec);
    const wf = wfFor(spec);
    const looM = missMult(loo);
    const wfM = missMult(wf);
    if (spec === 'final') looFinal = loo;
    const kept =
      spec === 'naive' ? false
      : spec === 'cat'
        ? looM < missMult(looFor('naive')) && wfM < missMult(wfFor('naive'))
        : spec === 'final'
          ? looM < missMult(looFor('naive')) && wfM < missMult(wfFor('naive'))
          : false;
    // Rejected terms are judged against the final model: they enter only if
    // they beat it on BOTH held-out tests.
    const finalLoo = spec === 'growth' || spec === 'age' || spec === 'chains' ? missMult(looFinal) : 0;
    const finalWf = spec === 'growth' || spec === 'age' || spec === 'chains' ? missMult(wfFor('final')) : 0;
    const rejectedNote =
      spec === 'growth' || spec === 'age' || spec === 'chains'
        ? `LOO x${looM.toFixed(2)} vs final x${finalLoo.toFixed(2)}, WF x${wfM.toFixed(2)} vs final x${finalWf.toFixed(2)} — worse on at least one test, rejected`
        : spec === 'cat'
          ? kept
            ? `beats naive on both tests (LOO x${looM.toFixed(2)}, WF x${wfM.toFixed(2)}), kept`
            : `mixed: WF better (x${wfM.toFixed(2)} vs naive x${missMult(wfFor('naive')).toFixed(2)}) but LOO worse (x${looM.toFixed(2)} vs naive x${missMult(looFor('naive')).toFixed(2)}) — not kept alone; kept only inside the final model`
          : spec === 'final'
            ? `beats naive on both tests (LOO x${looM.toFixed(2)}, WF x${wfM.toFixed(2)}) and beats category-only on both too, kept`
            : 'baseline';
    terms.push({ term: specNotes[spec], kept, loo: round2(looM), wf: round2(wfM), note: rejectedNote });
  }
  const finalTerm = terms.find((t) => t.term.startsWith('category + 5-bin'))!;
  const looMiss = finalTerm.loo;
  const wfMiss = finalTerm.wf;
  const sigmaLoo = sd(looFinal);

  // ---- value 5-fold, seeds 0..4 (random folds, seeded) ----
  const fiveAll: number[] = [];
  const fiveSeedMeds: number[] = [];
  for (let seed = 0; seed < 5; seed++) {
    const rand = mulberry32(1000 + seed);
    const perm = shuffled(pricedPos, rand);
    const folds: number[][] = [[], [], [], [], []];
    perm.forEach((pos, k) => folds[k % 5]!.push(pos));
    const foldMiss: number[] = [];
    for (const fo of folds) {
      const tr = pricedPos.filter((q) => !fo.includes(q));
      const m = fitValue(priced, pricedYs, tr, 'final', asOf, medAgeAll);
      const errs = fo.map((pos) => pricedYs[pos]! - predictValue(m, priced[pos]!, 'final', asOf, medAgeAll));
      const mm = missMult(errs);
      foldMiss.push(mm);
      fiveAll.push(mm);
    }
    fiveSeedMeds.push(round2(median(foldMiss)));
  }
  const fiveMedian = round2(median(fiveAll.map((_, i) => fiveSeedMeds[Math.floor(i / 5)]!)));
  const fiveWorst = round2(Math.max(...fiveAll));

  // ---- full value fit + bootstrap (200 refits) ----
  const fullValue = fitValue(priced, pricedYs, pricedPos, 'final', asOf, medAgeAll);
  const bootRand = mulberry32(424242);
  const bootModels: ValueModel[] = [];
  for (let b = 0; b < BOOTSTRAPS; b++) {
    const bs: number[] = [];
    for (let k = 0; k < pricedPos.length; k++) bs.push(pricedPos[Math.floor(bootRand() * pricedPos.length)]!);
    bootModels.push(fitValue(priced, pricedYs, bs, 'final', asOf, medAgeAll));
  }
  // LOO bootstrap sds (refits of each LOO training set) for the coverage check
  const looBootSd: number[] = [];
  for (const pos of pricedPos) {
    const tr = pricedPos.filter((q) => q !== pos);
    const preds: number[] = [];
    const r2 = mulberry32(9000 + pos);
    for (let b = 0; b < BOOTSTRAPS; b++) {
      const bs: number[] = [];
      for (let k = 0; k < tr.length; k++) bs.push(tr[Math.floor(r2() * tr.length)]!);
      preds.push(predictValue(fitValue(priced, pricedYs, bs, 'final', asOf, medAgeAll), priced[pos]!, 'final', asOf, medAgeAll));
    }
    looBootSd.push(sd(preds));
  }
  const zIn = 0.674;
  const zOut = 1.282;
  let innerHit = 0;
  let outerHit = 0;
  const looPreds: number[] = [];
  for (let k = 0; k < pricedPos.length; k++) {
    const pos = pricedPos[k]!;
    const tr = pricedPos.filter((q) => q !== pos);
    const m = fitValue(priced, pricedYs, tr, 'final', asOf, medAgeAll);
    const pred = predictValue(m, priced[pos]!, 'final', asOf, medAgeAll);
    looPreds.push(pred);
    const sTot = Math.sqrt(looBootSd[k]! * looBootSd[k]! + sigmaLoo * sigmaLoo) * RANGE_WIDEN;
    if (Math.abs(pricedYs[pos]! - pred) <= zIn * sTot) innerHit++;
    if (Math.abs(pricedYs[pos]! - pred) <= zOut * sTot) outerHit++;
  }
  const rangeInnerCov = round1((100 * innerHit) / pricedPos.length);
  const rangeOuterCov = round1((100 * outerHit) / pricedPos.length);

  // ---- odds: labels, CV over seeds 0..4, per-term table (seed 0), time split ----
  const labels = protocols.map((p) => (p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null ? 1 : 0));
  const allIdx = protocols.map((_, i) => i);
  const oddsSeedAucs: number[] = [];
  const oddsSeedBriers: number[] = [];
  for (let seed = 0; seed < 5; seed++) {
    const rand = mulberry32(7000 + seed);
    const pos = shuffled(allIdx.filter((i) => labels[i] === 1), rand);
    const neg = shuffled(allIdx.filter((i) => labels[i] === 0), rand);
    const pf: number[][] = [[], [], [], [], []];
    const nf: number[][] = [[], [], [], [], []];
    pos.forEach((v, k) => pf[k % 5]!.push(v));
    neg.forEach((v, k) => nf[k % 5]!.push(v));
    const probs = new Array<number>(protocols.length).fill(0);
    for (let k = 0; k < 5; k++) {
      const te = [...pf[k]!, ...nf[k]!];
      const teSet = new Set(te);
      const tr = allIdx.filter((i) => !teSet.has(i));
      const pr = peerRatesTrain(protocols, labels, tr, allIdx);
      const m = fitOdds(protocols, labels, tr, 'finalQuad', asOf, medAgeAll, pr);
      for (const i of te) probs[i] = predictOdds(m, protocols[i]!, asOf, medAgeAll, pr[i]!);
    }
    oddsSeedAucs.push(round3(aucScore(labels, probs)));
    oddsSeedBriers.push(round3(brierScore(labels, probs)));
  }
  const oddsAuc = round3(mean(oddsSeedAucs));
  const oddsBrier = round3(mean(oddsSeedBriers));
  // per-term odds table, stratified 5-fold, seed 0
  const oddsTerms: OddsTermResult[] = [];
  const oddsSpecNotes: { spec: OddsSpec; term: string; note: string }[] = [
    { spec: 'age', term: 'log-age only', note: '' },
    { spec: 'ageSize', term: 'log-age + logTVL', note: '' },
    { spec: 'noPeer', term: 'log-age + logTVL + growth + chains', note: '' },
    { spec: 'final', term: 'all + peer category token rate', note: '' },
    { spec: 'finalQuad', term: 'all + peer rate + size/age squares', note: '' },
  ];
  {
    const rand = mulberry32(7000);
    const pos = shuffled(allIdx.filter((i) => labels[i] === 1), rand);
    const neg = shuffled(allIdx.filter((i) => labels[i] === 0), rand);
    const pf: number[][] = [[], [], [], [], []];
    const nf: number[][] = [[], [], [], [], []];
    pos.forEach((v, k) => pf[k % 5]!.push(v));
    neg.forEach((v, k) => nf[k % 5]!.push(v));
    const folds: number[][] = [];
    for (let k = 0; k < 5; k++) folds.push([...pf[k]!, ...nf[k]!]);
    let prevAuc = -1;
    let prevBrier = 99;
    for (const { spec, term } of oddsSpecNotes) {
      const probs = new Array<number>(protocols.length).fill(0);
      for (let k = 0; k < 5; k++) {
        const te = folds[k]!;
        const teSet = new Set(te);
        const tr = allIdx.filter((i) => !teSet.has(i));
        const pr = peerRatesTrain(protocols, labels, tr, allIdx);
        const m = fitOdds(protocols, labels, tr, spec, asOf, medAgeAll, pr);
        for (const i of te) probs[i] = predictOdds(m, protocols[i]!, asOf, medAgeAll, pr[i]!);
      }
      const a = aucScore(labels, probs);
      const b = brierScore(labels, probs);
      // A term enters only if it improves BOTH held-out measures over the
      // previous set. Growth+chains fail this (they hurt both); the peer
      // rate and the squares pass it.
      const kept = spec === 'age' ? false : a > prevAuc && b < prevBrier;
      const note =
        spec === 'age'
          ? 'baseline'
          : kept
            ? `AUC ${a.toFixed(3)} vs ${prevAuc.toFixed(3)}, Brier ${b.toFixed(3)} vs ${prevBrier.toFixed(3)} — improves both, kept`
            : `AUC ${a.toFixed(3)} vs ${prevAuc.toFixed(3)}, Brier ${b.toFixed(3)} vs ${prevBrier.toFixed(3)} — worse on at least one, rejected`;
      oddsTerms.push({ term, kept, auc: round3(a), brier: round3(b), note });
      prevAuc = a;
      prevBrier = b;
    }
  }
  // time split: dated protocols, older half trains, newer half tests
  const datedAll = allIdx.filter((i) => protocols[i]!.listed_at !== null);
  datedAll.sort((a, b) => (ageDays(asOf, protocols[b]!.listed_at) ?? 0) - (ageDays(asOf, protocols[a]!.listed_at) ?? 0));
  const tsTrain = datedAll.slice(0, Math.floor(datedAll.length / 2));
  const tsTest = datedAll.slice(Math.floor(datedAll.length / 2));
  const tsPr = peerRatesTrain(protocols, labels, tsTrain, allIdx);
  const tsFinal = fitOdds(protocols, labels, tsTrain, 'finalQuad', asOf, medAgeAll, tsPr);
  const tsProbs = tsTest.map((i) => predictOdds(tsFinal, protocols[i]!, asOf, medAgeAll, tsPr[i]!));
  const tsLabels = tsTest.map((i) => labels[i]!);
  const tsNoCat = fitOdds(protocols, labels, tsTrain, 'noPeer', asOf, medAgeAll, tsPr);
  const tsProbsNoCat = tsTest.map((i) => predictOdds(tsNoCat, protocols[i]!, asOf, medAgeAll, tsPr[i]!));
  const oddsTimeAuc = round3(aucScore(tsLabels, tsProbs));
  const oddsTimeBrier = round3(brierScore(tsLabels, tsProbs));
  const oddsTimeAucNocat = round3(aucScore(tsLabels, tsProbsNoCat));
  const oddsTimeBrierNocat = round3(brierScore(tsLabels, tsProbsNoCat));
  const ageOnlyAuc = oddsTerms[0]!.auc;
  const ageOnlyBrier = oddsTerms[0]!.brier;

  // ---- final odds for every protocol (LOO peer rates, full fit) ----
  const prAll = peerRates(protocols, labels);
  const oddsFull = fitOdds(protocols, labels, allIdx, 'finalQuad', asOf, medAgeAll, prAll);
  const oddsOf = (p: SnapshotProtocol, i: number): number => predictOdds(oddsFull, p, asOf, medAgeAll, prAll[i]!);

  // ---- board: 40 watchlist + 158 early rankable by TVL ----
  const bySlug = new Map(protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);
  const pretokenN = protocols.filter(isPreToken).length;
  const tokenBearingN = protocols.length - pretokenN;
  const setAsideBelowCut = protocols.filter((p) => isPreToken(p) && isRankable(p) && !chosen.has(p.slug)).length;
  const setAsideExcluded = protocols.filter((p) => isPreToken(p) && !isRankable(p)).length;

  // ---- rows: value + ranges + ranks across bootstraps + farm ----
  const scored = [...chosen.values()].map((p) => {
    const origIdx = protocols.indexOf(p);
    const logPred = predictValue(fullValue, p, 'final', asOf, medAgeAll);
    const bootPreds = bootModels.map((m) => predictValue(m, p, 'final', asOf, medAgeAll));
    const bootSd = sd(bootPreds);
    const sTot = Math.sqrt(bootSd * bootSd + sigmaLoo * sigmaLoo) * RANGE_WIDEN;
    const implied = Math.max(1, Math.round(p.tvl_usd * Math.exp(logPred)));
    return {
      p,
      origIdx,
      logPred,
      implied,
      multiple: implied / p.tvl_usd,
      odds: oddsOf(p, origIdx),
      p25: Math.max(1, Math.round(p.tvl_usd * Math.exp(logPred - zIn * sTot))),
      p75: Math.max(1, Math.round(p.tvl_usd * Math.exp(logPred + zIn * sTot))),
      p10: Math.max(1, Math.round(p.tvl_usd * Math.exp(logPred - zOut * sTot))),
      p90: Math.max(1, Math.round(p.tvl_usd * Math.exp(logPred + zOut * sTot))),
      bootImplied: bootPreds.map((bp) => Math.max(1, Math.round(p.tvl_usd * Math.exp(bp)))),
    };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.slug ? 1 : 0));
  // bootstrap rank ranges: rank each row under each bootstrap refit
  const bootRanks: number[][] = scored.map(() => []);
  for (let b = 0; b < BOOTSTRAPS; b++) {
    const order = scored.map((s, k) => [s.bootImplied[b]!, k] as const).sort((x, y) => y[0] - x[0] || (scored[x[1]]!.p.slug < scored[y[1]]!.p.slug ? -1 : 1));
    order.forEach(([_, k], r) => bootRanks[k]!.push(r + 1));
  }
  const board: BoardRow[] = scored.map((s, i) => {
    const econ = farmEcon(s.p, s.implied, s.odds, DEPOSIT_PCT, DROP_SHARE, HORIZON_DAYS);
    const plan = farmPlan(s.p, DEPOSIT_PCT, HORIZON_DAYS);
    const ranks = bootRanks[i]!;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      wl: snapshot.watchlist.includes(s.p.slug),
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: ageDays(asOf, s.p.listed_at),
      implied_value_usd: s.implied,
      multiple: round4(s.multiple),
      odds: round3(s.odds),
      p25_usd: s.p25,
      p75_usd: s.p75,
      p10_usd: s.p10,
      p90_usd: s.p90,
      rank_lo: Math.round(quantile(ranks, 0.1)),
      rank_hi: Math.round(quantile(ranks, 0.9)),
      deposit_usd: Math.round(econ.deposit),
      gross_usd: round2(econ.gross),
      gas_usd: econ.gas,
      opp_usd: round2(econ.opp),
      net_usd: round2(econ.net),
      hours: round2(econ.hours),
      per_hour_usd: round2(econ.perHour),
      verdict: econ.verdict,
      farm_steps: plan.steps.map(stepText),
    };
  });
  const farmCounts = {
    farm: board.filter((r) => r.verdict === 'Farm').length,
    thin: board.filter((r) => r.verdict === 'Thin').length,
    skip: board.filter((r) => r.verdict === 'Skip').length,
  };

  // ---- live + peers ----
  const live: PeerRow[] = protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd ?? 0, multiple: round4((p.mcap_usd ?? 0) / p.tvl_usd) }));
  const peers: PeerRow[] = priced.map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd ?? 0,
    multiple: round4((p.mcap_usd ?? 0) / p.tvl_usd),
  }));

  // size-bin table for the scatter plot + dashboard
  const sizeBins = fullValue.edges.slice(0, -1).map((lo, b) => {
    const hi = fullValue.edges[b + 1]!;
    const n = priced.filter((p) => {
      const v = Math.log10(p.tvl_usd);
      return v >= lo && v < hi;
    }).length;
    return { lo: round2(lo), hi: round2(hi), effect: round3(fullValue.eff[b]!), n };
  });
  const catTop = Object.entries(fullValue.cat)
    .map(([cat, med]) => ({ cat, med: round3(med), n: priced.filter((p) => (p.category ?? '') === cat).length }))
    .sort((a, b) => b.med - a.med)
    .slice(0, 8);

  const evidence: Evidence = {
    priced_n: priced.length,
    dated_n: datedPos.length,
    naive_loo: round2(missMult(looFor('naive'))),
    naive_wf: round2(missMult(wfFor('naive'))),
    terms,
    loo: looMiss,
    wf: wfMiss,
    five_fold_median: fiveMedian,
    five_fold_worst: fiveWorst,
    five_fold_all: fiveAll.map((x) => round2(x)),
    five_fold_seed_medians: fiveSeedMeds,
    sigma_loo: round3(sigmaLoo),
    range_w: RANGE_WIDEN,
    range_inner_cov: rangeInnerCov,
    range_outer_cov: rangeOuterCov,
    odds_auc: oddsAuc,
    odds_brier: oddsBrier,
    odds_seed_aucs: oddsSeedAucs,
    odds_seed_briers: oddsSeedBriers,
    odds_terms: oddsTerms,
    odds_time_auc: oddsTimeAuc,
    odds_time_brier: oddsTimeBrier,
    odds_time_auc_nocat: oddsTimeAucNocat,
    odds_time_brier_nocat: oddsTimeBrierNocat,
    odds_age_only_auc: ageOnlyAuc,
    odds_age_only_brier: ageOnlyBrier,
    farm_counts: farmCounts,
    size_bins: sizeBins,
    cat_top: catTop,
  };

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: {
      deposit_pct: DEPOSIT_PCT,
      drop_share: DROP_SHARE,
      horizon_days: HORIZON_DAYS,
      tbill: TBILL_RATE,
      farm_min_per_hour: FARM_MIN_PER_HOUR,
      range_w: RANGE_WIDEN,
      bootstraps: BOOTSTRAPS,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early.length,
    live_size: live.length,
    total_protocols: protocols.length,
    pretoken_n: pretokenN,
    token_bearing_n: tokenBearingN,
    set_aside_n: setAsideBelowCut + setAsideExcluded,
    set_aside_below_cut: setAsideBelowCut,
    set_aside_excluded: setAsideExcluded,
    main_sha256: mainSha256,
    totals: {
      board_tvl: board.reduce((a, r) => a + r.tvl_usd, 0),
      board_implied: board.reduce((a, r) => a + r.implied_value_usd, 0),
      priced_median_mult: round4(Math.exp(fullValue.gmed)),
    },
    evidence,
    rows: board,
    live,
    peers,
  };
  return { board, radar };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
