// src/index.js  —  Main entry point
require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const path           = require('path');
const { createServer } = require('http');
const WebSocket      = require('ws');

const logger             = require('./logger');
const webhookRouter      = require('./routes/webhook');
const dashboardRouter    = require('./routes/dashboard');
const { TokenMonitor }   = require('./monitor');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Routes ────────────────────────────────────────────────────
app.use('/webhook', webhookRouter);
app.use('/api',     dashboardRouter);

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── HTTP + WebSocket server ───────────────────────────────────
const httpServer = createServer(app);
const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  logger.info('Dashboard WebSocket connected');
  // Push full state immediately on connect / reconnect
  const snapshot = TokenMonitor.getInstance().getDashboardData();
  ws.send(JSON.stringify({ type: 'snapshot', data: snapshot }));

  ws.on('error', (err) => logger.warn(`WS client error: ${err.message}`));
  ws.on('close', ()    => logger.info('Dashboard WebSocket disconnected'));
});

// Expose wss globally so wsHub.js can broadcast without circular imports
global._wss = wss;

// ── Start monitor ─────────────────────────────────────────────
TokenMonitor.getInstance().start();

// ── Listen ────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  logger.info(`🚀 Sol EMA Monitor  →  http://0.0.0.0:${PORT}`);
  logger.info(`   Webhook receiver →  POST http://0.0.0.0:${PORT}/webhook/add-token`);
});

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM — shutting down gracefully');
  TokenMonitor.getInstance().stop();
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  TokenMonitor.getInstance().stop();
  process.exit(0);
});
