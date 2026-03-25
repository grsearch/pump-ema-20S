// src/ema.js  —  EMA calculation + BUY/SELL signal logic
//
// BUY trigger (anti-shake):
//   EMA9 > EMA20  AND  EMA20 is rising (EMA20_now > EMA20_prev)
//   must hold for EMA_CONFIRM_BARS consecutive candles.
//   Only evaluated when tokenState.inPosition === false.
//
// SELL trigger (anti-shake):
//   EMA9 < EMA20  AND  EMA20 is declining (EMA20_now < EMA20_prev)
//   must hold for EMA_CONFIRM_BARS consecutive candles.
//   Only evaluated when tokenState.inPosition === true.
//
// Caller (monitor.js) responsibilities after signal fires:
//   BUY  → set inPosition=true,  bullishCount=0
//   SELL → set inPosition=false, bearishCount=0
//
// Multiple buy/sell cycles per token are supported.

const EMA_FAST     = parseInt(process.env.EMA_FAST          || '9');
const EMA_SLOW     = parseInt(process.env.EMA_SLOW          || '20');
const CONFIRM_BARS = parseInt(process.env.EMA_CONFIRM_BARS   || '2');
const KLINE_SEC    = parseInt(process.env.KLINE_INTERVAL_SEC || '15');

/**
 * Calculate EMA array for a price series (oldest-first).
 * Seeded with SMA for the first `period` values, then standard EMA.
 *
 * @param {number[]} closes
 * @param {number}   period
 * @returns {number[]}  same length as closes; NaN for warmup positions
 */
function calcEMA(closes, period) {
  const k      = 2 / (period + 1);
  const result = new Array(closes.length).fill(NaN);
  let prev     = null;

  for (let i = 0; i < closes.length; i++) {
    if (prev === null) {
      if (i >= period - 1) {
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
 * Evaluate whether a BUY or SELL signal should fire.
 *
 * Called every KLINE_INTERVAL_SEC by monitor._evaluateAll().
 *
 * @param {Array<{close: number}>} candles   oldest-first fixed-width bars
 * @param {Object} tokenState  fields read/mutated: inPosition, bullishCount, bearishCount
 * @returns {{ ema9: number, ema20: number, signal: null|'BUY'|'SELL', reason: string }}
 */
function evaluateSignal(candles, tokenState) {
  const closes = candles.map(c => c.close);
  const ema9s  = calcEMA(closes, EMA_FAST);
  const ema20s = calcEMA(closes, EMA_SLOW);
  const len    = closes.length;

  // Need EMA_SLOW bars to seed EMA20, plus 1 extra to compare slope
  if (len < EMA_SLOW + 1) {
    tokenState.bullishCount = 0;
    tokenState.bearishCount = 0;
    return { ema9: NaN, ema20: NaN, signal: null, reason: 'warming_up' };
  }

  const ema9_now   = ema9s[len - 1];
  const ema20_now  = ema20s[len - 1];
  const ema20_prev = ema20s[len - 2];

  // Safety guard — should not occur after warmup, but protect against edge cases
  if (isNaN(ema9_now) || isNaN(ema20_now) || isNaN(ema20_prev)) {
    return { ema9: NaN, ema20: NaN, signal: null, reason: 'ema_nan' };
  }

  const bullish   = ema9_now > ema20_now;   // EMA9 above EMA20
  const rising    = ema20_now > ema20_prev; // EMA20 slope upward
  const bearish   = ema9_now < ema20_now;   // EMA9 below EMA20
  const declining = ema20_now < ema20_prev; // EMA20 slope downward

  // ── BUY: only when flat (not holding a position) ──────────
  if (!tokenState.inPosition) {
    if (bullish && rising) {
      tokenState.bullishCount = (tokenState.bullishCount || 0) + 1;
      tokenState.bearishCount = 0;
    } else {
      tokenState.bullishCount = 0;
    }

    if (tokenState.bullishCount >= CONFIRM_BARS) {
      return {
        ema9:   ema9_now,
        ema20:  ema20_now,
        signal: 'BUY',
        reason: `EMA${EMA_FAST}>EMA${EMA_SLOW} & EMA${EMA_SLOW}↑ ×${tokenState.bullishCount}bars`,
      };
    }

    return { ema9: ema9_now, ema20: ema20_now, signal: null, reason: '' };
  }

  // ── SELL: only when holding a position ───────────────────
  if (bearish && declining) {
    tokenState.bearishCount = (tokenState.bearishCount || 0) + 1;
    tokenState.bullishCount = 0;
  } else {
    tokenState.bearishCount = 0;
  }

  if (tokenState.bearishCount >= CONFIRM_BARS) {
    return {
      ema9:   ema9_now,
      ema20:  ema20_now,
      signal: 'SELL',
      reason: `EMA${EMA_FAST}<EMA${EMA_SLOW} & EMA${EMA_SLOW}↓ ×${tokenState.bearishCount}bars`,
    };
  }

  return { ema9: ema9_now, ema20: ema20_now, signal: null, reason: '' };
}

/**
 * Aggregate raw price ticks into fixed-width OHLCV candles.
 * Empty buckets (no ticks in interval) are forward-filled from the previous close.
 *
 * @param {Array<{time: number, price: number}>} ticks   unix-ms, oldest-first
 * @param {number} intervalSec
 * @returns {Array<{time, open, high, low, close, volume}>}
 */
function buildCandles(ticks, intervalSec = KLINE_SEC) {
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
