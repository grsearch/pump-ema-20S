// src/routes/dashboard.js  —  REST API for dashboard
const express          = require('express');
const router           = express.Router();
const { sendSell }     = require('../webhookSender');
const { TokenMonitor } = require('../monitor');

// GET /api/dashboard  — full snapshot (tokens + signals + uptime)
router.get('/dashboard', (req, res) => {
  res.json(TokenMonitor.getInstance().getDashboardData());
});

// GET /api/tokens  — whitelist summary
router.get('/tokens', (req, res) => {
  const tokens = [...TokenMonitor.getInstance().tokens.values()].map(s => ({
    address:      s.address,
    symbol:       s.symbol,
    age:          s.age,
    lp:           s.lp,
    fdv:          s.fdv,
    currentPrice: s.currentPrice,
    entryPrice:   s.entryPrice,
    pnlPct:       s.pnlPct,
    lastSignal:   s.lastSignal,
    inPosition:   s.inPosition,
    tradeCount:   s.tradeCount,
    ema9:         isNaN(s.ema9)  ? null : +s.ema9.toFixed(8),
    ema20:        isNaN(s.ema20) ? null : +s.ema20.toFixed(8),
    addedAt:      s.addedAt,
    exitSent:     s.exitSent,
  }));
  res.json(tokens);
});

// GET /api/signals  — recent signal log (newest first)
router.get('/signals', (req, res) => {
  res.json(TokenMonitor.getInstance().signalLog.slice(0, 100));
});

// DELETE /api/tokens/:address  — manual removal
// Sends SELL only when there is an open position (inPosition=true)
router.delete('/tokens/:address', async (req, res) => {
  const monitor = TokenMonitor.getInstance();
  const state   = monitor.tokens.get(req.params.address);

  if (!state) {
    return res.status(404).json({ ok: false, error: 'Token not found' });
  }

  if (state.inPosition && !state.exitSent) {
    const sig = await sendSell(state.address, state.symbol, 'MANUAL_REMOVE');
    monitor._addSignalLog(sig);
  }

  state.exitSent   = true;
  state.inPosition = false;
  monitor._removeToken(state.address, 'MANUAL_REMOVE');
  res.json({ ok: true });
});

module.exports = router;
