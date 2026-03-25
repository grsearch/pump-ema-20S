// src/monitor.js  —  Core monitoring engine (Singleton)
//
// Full lifecycle:
//   1. Token received via POST /webhook/add-token
//      → inserted into map with exitSent=false, buySent=false
//      → _fetchMetaAndMaybeBuy() called immediately (async)
//
//   2. _fetchMetaAndMaybeBuy():
//      → fetch symbol / FDV / LP / age from Birdeye
//      → if FDV is null (unknown) OR FDV < FDV_MIN_USD:
//            log warning, set exitSent=true, remove silently after 1s  (no SELL)
//      → else:
//            send BUY webhook, set buySent=true
//
//   3. Every PRICE_POLL_SEC (5 s):
//      → for each token where !exitSent: fetch current price from Birdeye
//      → append tick {time, price}; set entryPrice on first tick after buySent
//      → ~4 ticks accumulate per 20 s candle
//
//   4. Every KLINE_INTERVAL_SEC (20 s):
//      → for each token where buySent && !exitSent:
//            build 20s OHLCV candles from ticks
//            run evaluateSignal() → checks EMA9/EMA20 strategy
//            if signal === 'SELL': send SELL webhook, exitSent=true, remove after 5s
//
//   5. Every 30 s (meta refresh):
//      → re-fetch FDV; if FDV drops below minimum AND buySent: send SELL, exit
//
//   6. Every 10 s (age check):
//      → if token age >= TOKEN_MAX_AGE_MIN:
//            buySent=true  → send SELL, exit
//            buySent=false → remove silently (was never bought)

const birdeye                          = require('./birdeye');
const { evaluateSignal, buildCandles } = require('./ema');
const { sendBuy, sendSell }            = require('./webhookSender');
const { broadcastToClients }           = require('./wsHub');
const logger                           = require('./logger');

const PRICE_POLL_SEC     = parseInt(process.env.PRICE_POLL_SEC        || '5');   // price fetch interval
const KLINE_INTERVAL_SEC = parseInt(process.env.KLINE_INTERVAL_SEC    || '20');  // candle / EMA eval interval
const TOKEN_MAX_AGE_MIN  = parseInt(process.env.TOKEN_MAX_AGE_MINUTES || '30');
const FDV_MIN_USD        = parseInt(process.env.FDV_MIN_USD           || '10000');
const MAX_TICKS_HISTORY  = 60 * 60 * 2; // 2 h of ticks max in RAM

class TokenMonitor {
  static instance = null;
  static getInstance() {
    if (!TokenMonitor.instance) TokenMonitor.instance = new TokenMonitor();
    return TokenMonitor.instance;
  }

  constructor() {
    this.tokens      = new Map();  // Map<address, TokenState>
    this.signalLog   = [];         // last 200 signal entries
    this._pollTimer  = null;
    this._klineTimer = null;
    this._metaTimer  = null;
    this._ageTimer   = null;
    this._dashTimer  = null;
  }

  // ── Add token to whitelist ──────────────────────────────────
  async addToken({ address, symbol, network = 'solana' }) {
    if (this.tokens.has(address)) {
      logger.info(`[Monitor] Already in whitelist: ${symbol} (${address.slice(0,8)})`);
      return { ok: false, reason: 'already_exists' };
    }

    const state = {
      address,
      symbol:       symbol || address.slice(0, 8),
      network,
      addedAt:      Date.now(),
      ticks:        [],
      candles:      [],
      currentPrice: null,
      ema9:         NaN,
      ema20:        NaN,
      lastSignal:   null,
      fdv:          null,
      lp:           null,
      age:          null,
      entryPrice:   null,
      pnlPct:       null,
      bearishCount: 0,
      buySent:      false,
      exitSent:     false,
    };

    this.tokens.set(address, state);
    logger.info(`[Monitor] ✅ Added: ${state.symbol} (${address})`);

    // Fetch meta first, then conditionally send BUY
    await this._fetchMetaAndMaybeBuy(state);

    broadcastToClients({ type: 'token_added', data: this._stateView(state) });
    return { ok: true };
  }

  // ── Initial meta fetch + FDV gate + BUY signal ───────────────
  async _fetchMetaAndMaybeBuy(state) {
    try {
      const overview = await birdeye.getTokenOverview(state.address);
      if (overview) {
        state.fdv    = overview.fdv ?? overview.mc ?? null;
        state.lp     = overview.liquidity ?? null;
        state.symbol = overview.symbol || state.symbol;
        const created = overview.createdAt || overview.created_at || null;
        if (created) {
          state.age = ((Date.now() - created * 1000) / 60000).toFixed(1);
        }
      }
    } catch (e) {
      logger.warn(`[Monitor] meta fetch error ${state.symbol}: ${e.message}`);
    }

    // Reject if FDV is unknown or below minimum — no position opened, no SELL needed
    if (state.fdv === null || state.fdv < FDV_MIN_USD) {
      const reason = state.fdv === null
        ? 'FDV_UNKNOWN'
        : `FDV_TOO_LOW($${state.fdv}<$${FDV_MIN_USD})`;
      logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${reason}`);
      state.exitSent = true;
      setTimeout(() => this._removeToken(state.address, reason), 1000);
      return;
    }

    // FDV is known and sufficient — send BUY once.
    // entryPrice will be set by _pollPrices() on the first successful price tick
    // after buySent=true (currentPrice is still null at this point).
    const sig = await sendBuy(state.address, state.symbol, 'NEW_TOKEN_WHITELIST');
    state.buySent = true;
    this._addSignalLog(sig);
  }

  // ── Periodic meta refresh every 30 s ─────────────────────────
  async _fetchMeta(state) {
    if (state.exitSent) return;
    try {
      const overview = await birdeye.getTokenOverview(state.address);
      if (!overview) return;

      state.fdv    = overview.fdv ?? overview.mc ?? null;
      state.lp     = overview.liquidity ?? null;
      state.symbol = overview.symbol || state.symbol;
      const created = overview.createdAt || overview.created_at || null;
      if (created) {
        state.age = ((Date.now() - created * 1000) / 60000).toFixed(1);
      }

      // FDV dropped below minimum after we already bought → SELL and exit
      if (state.buySent && state.fdv !== null && state.fdv < FDV_MIN_USD) {
        logger.warn(`[Monitor] ⚠️  FDV dropped: ${state.symbol} FDV=$${state.fdv} — sending SELL`);
        const sig = await sendSell(
          state.address, state.symbol, `FDV_DROPPED($${state.fdv}<$${FDV_MIN_USD})`
        );
        state.lastSignal = 'SELL';
        state.exitSent   = true;
        this._addSignalLog(sig);
        setTimeout(() => this._removeToken(state.address, 'FDV_DROP'), 5000);
      }
    } catch (e) {
      logger.warn(`[Monitor] meta refresh error ${state.symbol}: ${e.message}`);
    }
  }

  // ── Start all timers ──────────────────────────────────────────
  start() {
    logger.info(
      `[Monitor] Starting — price poll ${PRICE_POLL_SEC}s | kline ${KLINE_INTERVAL_SEC}s | FDV_MIN $${FDV_MIN_USD} | max_age ${TOKEN_MAX_AGE_MIN}min`
    );
    // Price polling: every PRICE_POLL_SEC (5 s) — ~4 ticks per 20 s candle
    this._pollTimer  = setInterval(() => this._pollPrices(), PRICE_POLL_SEC * 1000);
    // K-line evaluation: every KLINE_INTERVAL_SEC (20 s)
    this._klineTimer = setInterval(() => this._evaluateAll(), KLINE_INTERVAL_SEC * 1000);
    this._metaTimer  = setInterval(async () => {
      for (const s of this.tokens.values()) {
        await this._fetchMeta(s);
        await sleep(50);
      }
    }, 30_000);
    this._ageTimer   = setInterval(() => this._checkAgeExpiry(), 10_000);
    this._dashTimer  = setInterval(() => {
      broadcastToClients({ type: 'update', data: this.getDashboardData() });
    }, 3000);
  }

  stop() {
    [this._pollTimer, this._klineTimer, this._metaTimer, this._ageTimer, this._dashTimer]
      .forEach(t => t && clearInterval(t));
    logger.info('[Monitor] Stopped');
  }

  // ── Poll price every PRICE_POLL_SEC (5 s) ───────────────────
  // ~4 price samples per 20 s candle → accurate OHLCV high/low.
  // Requests staggered 50 ms apart to respect Birdeye rate limits.
  async _pollPrices() {
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent) continue;
      const price = await birdeye.getPrice(addr);
      if (price !== null && price > 0) {
        state.currentPrice = price;
        state.ticks.push({ time: Date.now(), price });
        if (state.ticks.length > MAX_TICKS_HISTORY) {
          state.ticks.splice(0, state.ticks.length - MAX_TICKS_HISTORY);
        }
        if (state.buySent && state.entryPrice === null) {
          state.entryPrice = price;
        }
      }
      await sleep(50);
    }
  }

  // ── Build 20 s candles & evaluate EMA strategy ───────────────
  // Runs every KLINE_INTERVAL_SEC (20 s), after ticks have been
  // accumulating via PRICE_POLL_SEC (5 s). Each 20 s candle contains
  // ~4 price samples → meaningful high/low/close values.
  async _evaluateAll() {
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent || !state.buySent || !state.ticks.length) continue;

      state.candles = buildCandles(state.ticks, KLINE_INTERVAL_SEC);

      const result = evaluateSignal(state.candles, state);
      state.ema9   = result.ema9;
      state.ema20  = result.ema20;

      // Live unrealised PnL
      if (state.entryPrice && state.currentPrice) {
        state.pnlPct = (
          (state.currentPrice - state.entryPrice) / state.entryPrice * 100
        ).toFixed(2);
      }

      if (result.signal === 'SELL') {
        logger.warn(`[Strategy] SELL ${state.symbol} — ${result.reason}`);
        const sig = await sendSell(addr, state.symbol, result.reason);
        state.lastSignal = 'SELL';
        state.exitSent   = true;
        this._addSignalLog(sig);
        setTimeout(() => this._removeToken(addr, 'SELL_SIGNAL'), 5000);
      }
    }
  }

  // ── Age expiry check every 10 s ──────────────────────────────
  // Uses the token's real on-chain age (state.age, from Birdeye) when available,
  // falling back to addedAt (time added to whitelist) if age hasn't been fetched yet.
  async _checkAgeExpiry() {
    const maxMin = TOKEN_MAX_AGE_MIN;
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent) continue;

      // Prefer real on-chain age over whitelist-entry age
      const ageMin = state.age !== null
        ? parseFloat(state.age)
        : (Date.now() - state.addedAt) / 60000;

      if (ageMin < maxMin) continue;

      state.exitSent = true; // set first to block any concurrent check

      if (state.buySent) {
        logger.info(`[Monitor] ⏰ Age expiry: ${state.symbol} (age ${ageMin.toFixed(1)}min) — sending SELL`);
        const sig = await sendSell(addr, state.symbol, `AGE_EXPIRY_${maxMin}min`);
        state.lastSignal = 'SELL_AGE';
        this._addSignalLog(sig);
        setTimeout(() => this._removeToken(addr, 'AGE_EXPIRY'), 5000);
      } else {
        // Never bought — remove silently, no SELL needed
        logger.info(`[Monitor] ⏰ Age expiry (no position): ${state.symbol} — removing silently`);
        this._removeToken(addr, 'AGE_EXPIRY_NO_POSITION');
      }
    }
  }

  // ── Remove token from whitelist ───────────────────────────────
  _removeToken(addr, reason) {
    const state = this.tokens.get(addr);
    if (state) {
      logger.info(`[Monitor] 🗑  Removed ${state.symbol} — ${reason}`);
      this.tokens.delete(addr);
      broadcastToClients({ type: 'token_removed', data: { address: addr, reason } });
    }
  }

  _addSignalLog(sig) {
    this.signalLog.unshift(sig);
    if (this.signalLog.length > 200) this.signalLog.length = 200;
  }

  _stateView(s) {
    return {
      address:       s.address,
      symbol:        s.symbol,
      age:           s.age,
      lp:            s.lp,
      fdv:           s.fdv,
      currentPrice:  s.currentPrice,
      entryPrice:    s.entryPrice,
      pnlPct:        s.pnlPct,
      ema9:          isNaN(s.ema9)  ? null : +s.ema9.toFixed(8),
      ema20:         isNaN(s.ema20) ? null : +s.ema20.toFixed(8),
      lastSignal:    s.lastSignal,
      candleCount:   s.candles.length,
      tickCount:     s.ticks.length,
      addedAt:       s.addedAt,
      exitSent:      s.exitSent,
      buySent:       s.buySent,
      recentCandles: s.candles.slice(-60),
    };
  }

  getDashboardData() {
    return {
      tokens:     [...this.tokens.values()].map(s => this._stateView(s)),
      signalLog:  this.signalLog.slice(0, 100),
      uptime:     process.uptime(),
      tokenCount: this.tokens.size,
    };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { TokenMonitor };
