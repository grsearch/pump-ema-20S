// src/webhookSender.js  —  send BUY/SELL signals to trading bot
const axios  = require('axios');
const logger = require('./logger');
const { broadcastToClients } = require('./wsHub');

const BUY_URL  = process.env.TRADING_BOT_BUY_URL  || 'http://43.162.112.89:3002/webhook/new-token';
const SELL_URL = process.env.TRADING_BOT_SELL_URL  || 'http://43.162.112.89:3002/force-sell';

/**
 * Send a BUY signal to the trading bot.
 * Also broadcasts the signal event to all dashboard WebSocket clients.
 */
async function sendBuy(mint, symbol, reason = 'EMA_CROSS_UP') {
  const payload = { mint, symbol };
  const entry = {
    id:      Date.now(),
    time:    new Date().toISOString(),
    type:    'BUY',
    mint,
    symbol,
    reason,
    url:     BUY_URL,
    status:  'pending',
  };
  try {
    const res    = await axios.post(BUY_URL, payload, { timeout: 5000 });
    entry.status   = 'sent';
    entry.httpCode = res.status;
    logger.warn(`[SIGNAL] BUY  ${symbol} (${mint.slice(0, 8)}) — ${reason} → HTTP ${res.status}`);
  } catch (e) {
    entry.status = 'error';
    entry.error  = e.message;
    logger.warn(`[SIGNAL] BUY  ${symbol} FAILED: ${e.message}`);
  }
  broadcastToClients({ type: 'signal', data: entry });
  return entry;
}

/**
 * Send a SELL signal to the trading bot.
 * Also broadcasts the signal event to all dashboard WebSocket clients.
 */
async function sendSell(mint, symbol, reason = 'EMA_CROSS_DOWN') {
  const payload = { mint, signal: 'SELL' };
  const entry = {
    id:      Date.now(),
    time:    new Date().toISOString(),
    type:    'SELL',
    mint,
    symbol,
    reason,
    url:     SELL_URL,
    status:  'pending',
  };
  try {
    const res    = await axios.post(SELL_URL, payload, { timeout: 5000 });
    entry.status   = 'sent';
    entry.httpCode = res.status;
    logger.warn(`[SIGNAL] SELL ${symbol} (${mint.slice(0, 8)}) — ${reason} → HTTP ${res.status}`);
  } catch (e) {
    entry.status = 'error';
    entry.error  = e.message;
    logger.warn(`[SIGNAL] SELL ${symbol} FAILED: ${e.message}`);
  }
  broadcastToClients({ type: 'signal', data: entry });
  return entry;
}

module.exports = { sendBuy, sendSell };
