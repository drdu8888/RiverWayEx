'use strict';
// Zero-dependency statistics: Spearman rank correlation with a permutation p-value,
// and Benjamini-Hochberg false-discovery-rate adjustment.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Average ranks (ties share the mean of the ranks they span).
function avgRanks(v) {
  const n = v.length;
  const idx = new Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => v[a] - v[b]);
  const r = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && v[idx[j + 1]] === v[idx[i]]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = rank;
    i = j + 1;
  }
  return r;
}

// Spearman rho between x and y (equal-length numeric arrays, no missing values).
// p-value: two-sided permutation test. Starts with `batch` shuffles and keeps going (up to
// `maxPerms`) only while fewer than `minExceed` shuffles have matched or beaten the observed
// correlation, so strong relationships get a finely resolved p-value without wasting time on noise.
// Deterministic for a given seed.
function spearman(x, y, opts) {
  const o = Object.assign({ seed: 1, batch: 2000, maxPerms: 60000, minExceed: 20 }, opts);
  const n = x.length;
  if (n < 3) return null;
  const rx = avgRanks(x);
  const ry = avgRanks(y);
  const mean = (n + 1) / 2;
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  let dx = 0;
  let dy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    cx[i] = rx[i] - mean;
    cy[i] = ry[i] - mean;
    dx += cx[i] * cx[i];
    dy += cy[i] * cy[i];
    sxy += cx[i] * cy[i];
  }
  if (dx === 0 || dy === 0) return null; // one variable is constant
  const rho = sxy / Math.sqrt(dx * dy);

  const rng = mulberry32(o.seed);
  const perm = Float64Array.from(cy);
  const thresh = Math.abs(sxy) - 1e-9;
  let exceed = 0;
  let done = 0;
  while (done < o.maxPerms && (done === 0 || exceed < o.minExceed)) {
    for (let b = 0; b < o.batch; b++) {
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = perm[i];
        perm[i] = perm[j];
        perm[j] = t;
      }
      let s = 0;
      for (let i = 0; i < n; i++) s += cx[i] * perm[i];
      if (Math.abs(s) >= thresh) exceed++;
    }
    done += o.batch;
  }
  return { rho, n, p: (exceed + 1) / (done + 1) };
}

// Benjamini-Hochberg q-values. `ps` may contain nulls (left null in the output).
function bhQ(ps) {
  const idx = [];
  ps.forEach((p, i) => {
    if (p != null) idx.push(i);
  });
  idx.sort((a, b) => ps[a] - ps[b]);
  const m = idx.length;
  const q = new Array(ps.length).fill(null);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    prev = Math.min(prev, (ps[idx[k]] * m) / (k + 1));
    q[idx[k]] = prev;
  }
  return q;
}

// Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf; max error ~1.5e-7).
function normalCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

// Probability that |Spearman rho| >= t for two UNRELATED variables with n paired observations
// (Fieller-Hartley-Pearson approximation: atanh(rho) ~ Normal(0, 1.06 / (n - 3))).
// Checked against 200,000-shuffle simulations for n = 12..100: within ~10% of the simulated tail,
// slightly conservative at small n.
function chanceTail(t, n) {
  if (n < 5) return 1;
  const z = Math.atanh(Math.min(t, 0.999999)) / Math.sqrt(1.06 / (n - 3));
  return 2 * (1 - normalCdf(z));
}

module.exports = { spearman, bhQ, hashStr, avgRanks, mulberry32, normalCdf, chanceTail };
