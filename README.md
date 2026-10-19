# Schwab-trading-terminal

This is a TradingView trading terminal adapted to use the Schwab API.

This project is in no way affiliated with Schwab or TradingView, **nor is it an official project**. We recommend that you protect your account.

I'm fed up with Schwab's official trading app, and it doesn't even integrate with TradingView. Their competitor, `Fidelity, already supports TradingView`. Maybe it's time we switch to Fidelity.

Start from here [![Wiki](https://img.shields.io/badge/docs-Wiki-blue.svg)](https://github.com/invmy/Schwab-trading-terminal/wiki)

## API Limits

### Trading Hours and Order Types


| Trading Session | Time Window (Eastern Time - ET) | Supported Asset Classes | Notes & Restrictions |
| --- | --- | --- | --- |
| **Overnight Session** | **Not Supported** (`20:00 - 04:00`) | None | No orders or executions allowed during this window |
| **Early Pre-Market** | `04:00 - 07:00` | **Not Supported** | Trading is not permitted during this early session |
| **Pre-Market** | `07:00 - 09:30` | Equities only | Limit orders only; Options trading is generally unavailable |
| **Regular Market Hours** | `09:30 - 16:00` | Equities, Equity Options | Full order type support (Market, Limit, Stop, etc.) |
| **After-Hours** | `16:00 - 20:00` | Equities only | Limit orders only; Options trading is generally unavailable |

### Extended-hours trading data 

If ETH is enabled, requests for historical data at the minute level will most likely fail.

## Features
- [x] Candlestick Chart Data (`Stocks`, `Stock Options`, `Futures`)
- [x] Single-leg order
- [x] OCO Orders for Take-Profit and Stop-Loss on Positions
- [ ] Bracketed orders on trigger orders
- [x] Template Storage Synchronization Based on Cloudflare D1
- [ ] Switch between light and dark themes
- [ ] Synchronize Watchlist
- [ ] ...

## Screenshot
![chart](/img/chart.png)
![order](/img/OCO_order.png)
![option](/img/option.png)