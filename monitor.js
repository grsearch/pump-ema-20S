// src/ema.js  —  EMA calculation + SELL signal logic
//
// SELL trigger (anti-shake):
//   EMA9 < EMA20  AND  EMA20 is declining (EMA20_now < EMA20_prev)
//   must hold for EMA_CONFIRM_BARS (default 2) consecutive 20s candles.
//
// Once SELL fires, monitor.js sets exitSent=true immediately, so
// evaluateSignal() is never called again for that token — no need
// for a sellFired flag here. State is clean and simple.

const EMA_FAST       = parseInt(process.env.EMA_FAST         || '9');
const EMA_SLOW       = parseInt(process.env.EMA_SLOW         || '20');
const CONFIRM_BARS   = parseInt(process.env.EMA_CONFIRM_BARS || '2');
const KLINE_INTERVAL = parseInt(process.env.KLINE_INTERVAL_SEC || '20');

/**
 * Calculate EMA array for a price series (oldest-first).
 * Seeded with SMA for the first window, then standard EMA formula.
 *
 * @param {number[]} closes
 * @param {number}   period
 * @returns {number[]}  same length; NaN for warmup positions
 */
function calcEMA(closes, period) {
  const k      = 2 / (period + 1);
  const result = new Array(closes.length).fill(NaN);
  let prev     = null;

  for (let i = 0; i < closes.length; i++) {
    if (prev === null) {
      if (i >= period - 1) {
        // Seed: SMA of the first `period` values
        prev      = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
        result[i] = prev;
      }
    } else {
      prev      = closes[i] * k + prev * (1 - k);
      result[i] = prev;
    }
  }
  return result;
}

/**
 * Evaluate whether a SELL signal should fire given the current candle history.
 *
 * Called every KLINE_INTERVAL_SEC by monitor._evaluateAll().
 * tokenState.bearishCount is the only mutable field touched here.
 *
 * @param {Array<{close: number}>} candles   oldest-first, 20s bars
 * @param {Object}                 tokenState per-token state (bearishCount mutated)
 * @returns {{ ema9: number, ema20: number, signal: null|'SELL', reason: string }}
 */
function evaluateSignal(candles, tokenState) {
  const closes = candles.map(c => c.close);
  const ema9s  = calcEMA(closes, EMA_FAST);
  const ema20s = calcEMA(closes, EMA_SLOW);

  const len = closes.length;

  // Need at least EMA_SLOW+1 bars: EMA_SLOW to compute EMA20, +1 to compare prev
  if (len < EMA_SLOW + 1) {
    tokenState.bearishCount = 0;
    return { ema9: NaN, ema20: NaN, signal: null, reason: 'warming_up' };
  }

  const ema9_now   = ema9s[len - 1];
  const ema20_now  = ema20s[len - 1];
  const ema20_prev = ema20s[len - 2];

  const bearish   = ema9_now < ema20_now;       // EMA9 below EMA20
  const declining = ema20_now < ema20_prev;     // EMA20 slope downward

  // Both conditions must hold simultaneously; one break resets the counter
  if (bearish && declining) {
    tokenState.bearishCount = (tokenState.bearishCount || 0) + 1;
  } else {
    tokenState.bearishCount = 0;
  }

  if (tokenState.bearishCount >= CONFIRM_BARS) {
    const count = tokenState.bearishCount;
    tokenState.bearishCount = 0; // reset so state is clean if token is ever re-evaluated
    return {
      ema9:   ema9_now,
      ema20:  ema20_now,
      signal: 'SELL',
      reason: `EMA${EMA_FAST} < EMA${EMA_SLOW} & EMA${EMA_SLOW}↓ × ${count} bars`,
    };
  }

  return { ema9: ema9_now, ema20: ema20_now, signal: null, reason: '' };
}

/**
 * Aggregate raw price ticks into fixed-width OHLCV candles.
 * With PRICE_POLL_SEC=5 and KLINE_INTERVAL_SEC=20, each candle
 * contains ~4 price samples → accurate OHLCV high/low.
 * Gaps (no ticks in a bucket) are forward-filled from the previous close.
 *
 * @param {Array<{time: number, price: number}>} ticks   unix-ms timestamps
 * @param {number} intervalSec
 * @returns {Array<{time, open, high, low, close, volume}>}
 */
function buildCandles(ticks, intervalSec = KLINE_INTERVAL) {
  if (!ticks.length) return [];

  const intervalMs = intervalSec * 1000;
  const candles    = [];
  let bucketStart  = Math.floor(ticks[0].time / intervalMs) * intervalMs;
  let current      = null;

  for (const tick of ticks) {
    const bucket = Math.floor(tick.time / intervalMs) * intervalMs;

    if (bucket !== bucketStart) {
      if (current) candles.push(current);

      // Forward-fill any empty buckets between last candle and this tick
      let gap = bucketStart + intervalMs;
      while (gap < bucket) {
        const prev = candles[candles.length - 1];
        candles.push({
          time: gap, open: prev.close, high: prev.close,
          low:  prev.close, close: prev.close, volume: 0,
        });
        gap += intervalMs;
      }

      bucketStart = bucket;
      current     = null;
    }

    if (!current) {
      current = {
        time: bucket, open: tick.price, high: tick.price,
        low:  tick.price, close: tick.price, volume: 1,
      };
    } else {
      if (tick.price > current.high) current.high = tick.price;
      if (tick.price < current.low)  current.low  = tick.price;
      current.close = tick.price;
      current.volume++;
    }
  }

  if (current) candles.push(current);
  return candles;
}

module.exports = { calcEMA, evaluateSignal, buildCandles, EMA_FAST, EMA_SLOW };
