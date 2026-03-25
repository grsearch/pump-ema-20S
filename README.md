# SOL EMA Monitor

Solana 新币 EMA9/EMA20 策略监控系统。  
通过 Birdeye API 实时获取价格，构建 15 秒 K 线，在 1 小时监控窗口内自动执行多次买卖。

---

## 策略逻辑

| 阶段 | 说明 |
|------|------|
| **收录** | 外部扫描服务发送 webhook → 立即拉取 FDV，低于阈值直接拒绝 |
| **等待买入** | EMA9 上穿 EMA20 且 EMA20 斜率向上，连续 2 根 K线确认 → 发送 BUY |
| **持仓监控** | EMA9 下穿 EMA20 且 EMA20 斜率向下，连续 2 根 K线确认 → 发送 SELL |
| **循环** | SELL 后代币继续留在白名单，等待下一次金叉买入 |
| **到期退出** | 60 分钟监控期满：有持仓先 SELL 再移除，无持仓静默移除 |

### 买入条件（同时满足）
```
EMA9  > EMA20          （金叉：EMA9 上穿）
EMA20 > EMA20_prev     （EMA20 斜率向上）
连续满足 >= 2 根 15s K线
```

### 卖出条件（同时满足）
```
EMA9  < EMA20          （死叉：EMA9 下穿）
EMA20 < EMA20_prev     （EMA20 斜率向下）
连续满足 >= 2 根 15s K线
```

---

## 目录结构

```
sol-ema-monitor/
├── src/
│   ├── index.js           # 主入口，HTTP + WebSocket 服务
│   ├── monitor.js         # 核心引擎（价格轮询、K线构建、策略调度）
│   ├── ema.js             # EMA 计算 + BUY/SELL 信号逻辑
│   ├── birdeye.js         # Birdeye API 封装
│   ├── webhookSender.js   # 向机器人发送买卖信号
│   ├── wsHub.js           # WebSocket 广播
│   ├── logger.js          # 日志（console + 文件）
│   └── routes/
│       ├── webhook.js     # POST /webhook/add-token
│       └── dashboard.js   # GET/DELETE /api/*
├── public/
│   └── index.html         # 实时 Dashboard（自包含单文件）
├── logs/                  # 运行日志（gitignored）
├── .env.example           # 环境变量模板
├── sol-ema-monitor.service # systemd unit（参考用）
├── deploy.sh              # 一键部署脚本
└── package.json
```

---

## 快速部署（Ubuntu + systemd）

### 1. 克隆并进入目录

```bash
git clone https://github.com/YOUR_USERNAME/sol-ema-monitor.git
cd sol-ema-monitor
```

### 2. 一键部署

```bash
bash deploy.sh
```

脚本自动完成：安装 Node.js 18、npm install、生成 `.env`、注册并启动 systemd 服务。

### 3. 填写 API Key

```bash
nano .env
# 填入 BIRDEYE_API_KEY 等配置
sudo systemctl restart sol-ema-monitor
```

### 4. 开放防火墙端口

```bash
# 腾讯云安全组添加 TCP 3001 入站规则，或：
sudo ufw allow 3001/tcp
```

### 5. 访问 Dashboard

```
http://YOUR_SERVER_IP:3001
```

---

## systemd 常用命令

```bash
# 查看运行状态
sudo systemctl status sol-ema-monitor

# 实时日志
sudo journalctl -u sol-ema-monitor -f

# 最近 1 小时日志
sudo journalctl -u sol-ema-monitor --since '1h ago'

# 重启 / 停止 / 开机自启
sudo systemctl restart sol-ema-monitor
sudo systemctl stop    sol-ema-monitor
sudo systemctl enable  sol-ema-monitor   # 已由 deploy.sh 设置
```

---

## API 说明

### 接收新币（来自扫描服务器）

```bash
curl -X POST http://YOUR_SERVER:3001/webhook/add-token \
  -H "Content-Type: application/json" \
  -d '{"network":"solana","address":"TOKEN_ADDRESS","symbol":"TOKEN_SYMBOL"}'
```

响应：
```json
{ "ok": true }
```

### 查询接口

```bash
curl http://YOUR_SERVER:3001/api/dashboard   # 完整快照
curl http://YOUR_SERVER:3001/api/tokens      # 白名单列表
curl http://YOUR_SERVER:3001/api/signals     # 信号记录
curl http://YOUR_SERVER:3001/webhook/status  # 健康检查
```

### 手动移除代币（有持仓时自动发 SELL）

```bash
curl -X DELETE http://YOUR_SERVER:3001/api/tokens/TOKEN_ADDRESS
```

---

## 机器人 Webhook 格式

**买入信号：**
```
POST TRADING_BOT_BUY_URL
{"mint": "TOKEN_ADDRESS", "symbol": "TOKEN_SYMBOL"}
```

**卖出信号：**
```
POST TRADING_BOT_SELL_URL
{"mint": "TOKEN_ADDRESS", "signal": "SELL"}
```

---

## 环境变量说明

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BIRDEYE_API_KEY` | — | Birdeye API Key（必填） |
| `TRADING_BOT_BUY_URL` | — | 机器人买入 Webhook URL |
| `TRADING_BOT_SELL_URL` | — | 机器人卖出 Webhook URL |
| `PORT` | `3001` | HTTP 服务端口 |
| `TOKEN_MAX_AGE_MINUTES` | `60` | 监控窗口时长（分钟） |
| `FDV_MIN_USD` | `10000` | 最低 FDV 门槛（美元） |
| `EMA_FAST` | `9` | 快线周期 |
| `EMA_SLOW` | `20` | 慢线周期 |
| `EMA_CONFIRM_BARS` | `2` | 防震荡：连续确认 K 线数 |
| `PRICE_POLL_SEC` | `5` | 价格轮询间隔（秒） |
| `KLINE_INTERVAL_SEC` | `15` | K 线宽度（秒） |

---

## 日志文件

| 文件 | 内容 |
|------|------|
| `logs/monitor.log` | 全量运行日志（10MB × 5 轮转） |
| `logs/signals.log` | 仅买卖信号事件（5MB × 3 轮转） |

也可通过 journald 查看：
```bash
sudo journalctl -u sol-ema-monitor -f
```

---

## 常见问题

**Q: Birdeye 429 超频？**  
A: 每个代币每次轮询间隔 50ms 错开请求。同时监控 > 20 个代币时可适当增大 `PRICE_POLL_SEC`。

**Q: EMA 显示 WARMING UP？**  
A: 正常。EMA20 需要至少 21 根 K线（21 × 15s ≈ 5 分钟）才能计算。预热期内不会触发任何信号。

**Q: 机器人没收到信号？**  
A: 检查 `TRADING_BOT_BUY_URL` / `TRADING_BOT_SELL_URL` 是否正确，目标服务是否在线。查看 `logs/signals.log` 或 `journalctl` 确认发送状态。

**Q: 代币被拒绝（FDV_UNKNOWN / FDV_TOO_LOW）？**  
A: Birdeye 返回的 FDV 为 null 或低于 `FDV_MIN_USD`，代币被静默拒绝，不会发任何信号，也不会出现在 Dashboard。
