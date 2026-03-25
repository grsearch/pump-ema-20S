// src/monitor.js  —  Core monitoring engine (Singleton)
//
// Token lifecycle (multi-trade mode):
//
//   1. POST /webhook/add-token  →  addToken()
//      - State created with inPosition=false, exitSent=false
//      - _fetchMetaAndCheckFDV() called immediately
//
//   2. _fetchMetaAndCheckFDV()
//      - Fetches symbol / FDV / LP / age from Birdeye
//      - FDV null or < FDV_MIN_USD  →  exitSent=true, remove silently (no SELL, no broadcast)
//      - FDV OK  →  broadcast token_added, EMA monitoring begins
//
//   3. Every PRICE_POLL_SEC (5 s)
//      - Fetch current price for all active tokens
//      - Append tick {time, price}
//
//   4. Every KLINE_INTERVAL_SEC (15 s)
//      - Build OHLCV candles from ticks
//      - evaluateSignal():
//          BUY  →  sendBuy, inPosition=true, record entryPrice, bullishCount=0
//          SELL →  sendSell, inPosition=false, entryPrice=null, bearishCount=0, tradeCount++
//                  token stays in map — can BUY again on next crossover
//
//   5. Every 30 s  (meta refresh)
//      - Re-fetch FDV; if inPosition && FDV < min  →  sendSell, exitSent=true, remove
//
//   6. Every 10 s  (age check)
//      - token age >= TOKEN_MAX_AGE_MIN (60 min):
//          inPosition=true   →  sendSell then remove
//          inPosition=false  →  remove silently

const birdeye                          = require('./birdeye');
const { evaluateSignal, buildCandles } = require('./ema');
const { sendBuy, sendSell }            = require('./webhookSender');
const { broadcastToClients }           = require('./wsHub');
const logger                           = require('./logger');

const PRICE_POLL_SEC     = parseInt(process.env.PRICE_POLL_SEC        || '5');
const KLINE_INTERVAL_SEC = parseInt(process.env.KLINE_INTERVAL_SEC    || '15');
const TOKEN_MAX_AGE_MIN  = parseInt(process.env.TOKEN_MAX_AGE_MINUTES  || '60');
const FDV_MIN_USD        = parseInt(process.env.FDV_MIN_USD            || '10000');
const MAX_TICKS_HISTORY  = 60 * 60 * 2; // cap at 2 h of ticks in RAM

class TokenMonitor {
  static instance = null;
  static getInstance() {
    if (!TokenMonitor.instance) TokenMonitor.instance = new TokenMonitor();
    return TokenMonitor.instance;
  }

  constructor() {
    this.tokens      = new Map(); // Map<address, TokenState>
    this.signalLog   = [];        // last 200 signal events
    this._pollTimer  = null;
    this._klineTimer = null;
    this._metaTimer  = null;
    this._ageTimer   = null;
    this._dashTimer  = null;
  }

  // ── Add token ─────────────────────────────────────────────
  async addToken({ address, symbol, network = 'solana' }) {
    if (this.tokens.has(address)) {
      logger.info(`[Monitor] Already watching: ${symbol} (${address.slice(0, 8)})`);
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
      bullishCount: 0,     // consecutive bars BUY condition held
      bearishCount: 0,     // consecutive bars SELL condition held
      inPosition:   false, // true = open buy position
      tradeCount:   0,     // completed round-trips this session
      exitSent:     false, // true = token scheduled for removal
    };

    this.tokens.set(address, state);
    logger.info(`[Monitor] ✅ Added to map: ${state.symbol} (${address})`);

    // FDV gate — broadcasts token_added only if token passes
    await this._fetchMetaAndCheckFDV(state);

    return { ok: true };
  }

  // ── Initial meta fetch + FDV gate ─────────────────────────
  // FIX: broadcast token_added ONLY after passing FDV check,
  //      so the dashboard never shows tokens that get immediately rejected.
  async _fetchMetaAndCheckFDV(state) {
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

    if (state.fdv === null || state.fdv < FDV_MIN_USD) {
      const reason = state.fdv === null
        ? 'FDV_UNKNOWN'
        : `FDV_TOO_LOW($${state.fdv}<$${FDV_MIN_USD})`;
      logger.warn(`[Monitor] ⛔ ${state.symbol} rejected — ${reason}`);
      state.exitSent = true;
      // Remove from map silently — no SELL, no dashboard broadcast
      setTimeout(() => this._removeToken(state.address, reason), 1000);
      return;
    }

    logger.info(
      `[Monitor] ✅ ${state.symbol} approved — FDV $${state.fdv} — waiting for EMA9↑EMA20`
    );
    // Only broadcast after passing FDV check
    broadcastToClients({ type: 'token_added', data: this._stateView(state) });
  }

  // ── Periodic meta refresh every 30 s ─────────────────────
  // FIX: removed duplicate broadcastToClients call here.
  //      webhookSender.sendSell() already broadcasts the signal internally.
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

      // FDV collapse while holding a position → force exit
      if (state.inPosition && state.fdv !== null && state.fdv < FDV_MIN_USD) {
        logger.warn(
          `[Monitor] ⚠️  FDV collapsed: ${state.symbol} $${state.fdv} — forcing SELL`
        );
        state.exitSent   = true; // set before await to block concurrent triggers
        state.inPosition = false;
        const sig = await sendSell(
          state.address, state.symbol,
          `FDV_DROPPED($${state.fdv}<$${FDV_MIN_USD})`
        );
        state.lastSignal = 'SELL';
        state.entryPrice = null;
        state.pnlPct     = null;
        this._addSignalLog(sig);
        // sendSell already called broadcastToClients({type:'signal'})
        setTimeout(() => this._removeToken(state.address, 'FDV_DROP'), 5000);
      }
    } catch (e) {
      logger.warn(`[Monitor] meta refresh error ${state.symbol}: ${e.message}`);
    }
  }

  // ── Start timers ──────────────────────────────────────────
  start() {
    logger.info(
      `[Monitor] Starting — poll ${PRICE_POLL_SEC}s | kline ${KLINE_INTERVAL_SEC}s` +
      ` | FDV_MIN $${FDV_MIN_USD} | max_age ${TOKEN_MAX_AGE_MIN}min`
    );
    this._pollTimer  = setInterval(() => this._pollPrices(),   PRICE_POLL_SEC * 1000);
    this._klineTimer = setInterval(() => this._evaluateAll(),  KLINE_INTERVAL_SEC * 1000);
    this._metaTimer  = setInterval(() => {
      this.tokens.forEach(s => this._fetchMeta(s));
    }, 30_000);
    this._ageTimer  = setInterval(() => this._checkAgeExpiry(), 10_000);
    this._dashTimer = setInterval(() => {
      broadcastToClients({ type: 'update', data: this.getDashboardData() });
    }, 3000);
  }

  stop() {
    [this._pollTimer, this._klineTimer, this._metaTimer, this._ageTimer, this._dashTimer]
      .forEach(t => t && clearInterval(t));
    logger.info('[Monitor] Stopped');
  }

  // ── Price polling ─────────────────────────────────────────
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
      }
      await sleep(50); // stagger requests to respect Birdeye rate limit
    }
  }

  // ── Candle build + EMA evaluation ─────────────────────────
  async _evaluateAll() {
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent || !state.ticks.length) continue;

      state.candles = buildCandles(state.ticks, KLINE_INTERVAL_SEC);
      const result  = evaluateSignal(state.candles, state);
      state.ema9    = result.ema9;
      state.ema20   = result.ema20;

      // Update live PnL only while holding
      if (state.inPosition && state.entryPrice && state.currentPrice) {
        state.pnlPct = (
          (state.currentPrice - state.entryPrice) / state.entryPrice * 100
        ).toFixed(2);
      }

      if (result.signal === 'BUY') {
        // ── Enter position ───────────────────────────────────
        logger.warn(`[Strategy] BUY  ${state.symbol} — ${result.reason}`);
        const sig = await sendBuy(addr, state.symbol, result.reason);

        state.lastSignal  = 'BUY';
        state.inPosition  = true;
        // FIX: guard against null currentPrice (price poll may not have fired yet)
        state.entryPrice  = state.currentPrice ?? null;
        state.pnlPct      = null;
        state.bullishCount = 0; // prevent immediate re-fire on next eval

        this._addSignalLog(sig);

      } else if (result.signal === 'SELL') {
        // ── Exit position ────────────────────────────────────
        logger.warn(`[Strategy] SELL ${state.symbol} — ${result.reason}`);
        const sig = await sendSell(addr, state.symbol, result.reason);

        state.lastSignal   = 'SELL';
        state.inPosition   = false;
        state.entryPrice   = null;
        state.pnlPct       = null;
        state.tradeCount  += 1;
        state.bearishCount = 0; // prevent immediate re-fire on next eval

        this._addSignalLog(sig);
        // Token stays in map — next BUY crossover will open a new position
      }
    }
  }

  // ── Age expiry ────────────────────────────────────────────
  async _checkAgeExpiry() {
    const maxMs = TOKEN_MAX_AGE_MIN * 60 * 1000;
    for (const [addr, state] of this.tokens.entries()) {
      if (state.exitSent) continue;
      if (Date.now() - state.addedAt < maxMs) continue;

      state.exitSent = true; // block concurrent age-check iterations

      if (state.inPosition) {
        logger.info(`[Monitor] ⏰ Age expiry: ${state.symbol} — closing position`);
        const sig = await sendSell(addr, state.symbol, `AGE_EXPIRY_${TOKEN_MAX_AGE_MIN}min`);
        state.lastSignal = 'SELL';
        state.inPosition = false;
        state.entryPrice = null;
        state.pnlPct     = null;
        this._addSignalLog(sig);
        setTimeout(() => this._removeToken(addr, 'AGE_EXPIRY'), 5000);
      } else {
        logger.info(`[Monitor] ⏰ Age expiry (no position): ${state.symbol} — removing`);
        this._removeToken(addr, 'AGE_EXPIRY_NO_POSITION');
      }
    }
  }

  // ── Remove token ──────────────────────────────────────────
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
      inPosition:    s.inPosition,
      tradeCount:    s.tradeCount,
      exitSent:      s.exitSent,
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
