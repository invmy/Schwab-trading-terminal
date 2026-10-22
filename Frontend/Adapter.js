export class TradingAdapter {
    #SERVER;
    #HOST;

    #SUB_pool = new Map();
    #SUB_guid = new Map();
    #SUB_cooldown = new Map();

    #CACHE_info = new Map();
    #CACHE_quote = new Map();
    #CACHE_LastBar = new Map();
    #CACHE_BarStartVolume = new Map();

    //Broker
    #status = 2
    #account
    #accounts

    #CACHE_positions
    #CACHE_orders
    #liquidationValue
    #buyingPower
    #cashBalance

    constructor(SERVER) {
        this.#SERVER = SERVER;

        window.addEventListener('sse-message', (event) => {
            const dataList = event.detail?.data;
            if (!Array.isArray(dataList)) return;

            const serviceHandlers = [
                {
                    match: service => service.includes('LEVELONE'),
                    handle: (i) => {
                        i.content.forEach(c => {

                            const key = c.key;
                            if (!key) return;

                            let quote = this.#CACHE_quote.get(key)
                            if (!quote) return;

                            const ts = Number(i.timestamp || Date.now());

                            let rawData = {};

                            switch (i.service) {
                                case 'LEVELONE_EQUITIES':
                                    rawData = {
                                        lp: c["29"],
                                        ask: c["2"],
                                        bid: c["1"],
                                        ch: c["31"],
                                        chp: c["43"],
                                        rtc: c["3"],
                                        rch: c["50"],
                                        rchp: c["51"],
                                        rtc_time: ts / 1000,
                                        open_price: c["17"],
                                        high_price: c["10"],
                                        low_price: c["11"],
                                        prev_close_price: c["12"],
                                        volume: c["8"],
                                        // ntc: c["33"],
                                        // nch: c["18"],
                                        // nchp: c["42"],
                                        // ntc_time: ts / 1000,
                                    };
                                    break;

                                case 'LEVELONE_OPTIONS':
                                    rawData = {
                                        lp: c["4"],
                                        ask: c["3"],
                                        bid: c["2"],
                                        ch: c["19"] || c["45"],
                                        chp: c["44"] || c["46"],
                                        open_price: c["15"],
                                        high_price: c["5"],
                                        low_price: c["6"],
                                        prev_close_price: c["7"],
                                        volume: c["8"],
                                        rtc: c["4"],
                                    };
                                    break;

                                case 'LEVELONE_FUTURES':
                                    rawData = {
                                        lp: c["3"] || c['24'],
                                        ask: c["2"],
                                        bid: c["1"],
                                        ch: c["19"],
                                        chp: c["20"],
                                        open_price: c["18"],
                                        high_price: c["12"],
                                        low_price: c["13"],
                                        prev_close_price: c["14"],
                                        volume: c["8"],
                                        rtc: c["3"] || c['24'],
                                        rtc_time: ts / 1000,
                                    };
                                    break;

                                case 'LEVELONE_FUTURES_OPTIONS':
                                    rawData = {
                                        lp: c["3"] || c['19'],
                                        ask: c["2"],
                                        bid: c["1"],
                                        open_price: c["17"],
                                        high_price: c["12"],
                                        low_price: c["13"],
                                        prev_close_price: c["14"],
                                        volume: c["8"],
                                        rtc: c["3"] || c['19'],
                                    };
                                    break;

                                case 'LEVELONE_FOREX':
                                    rawData = {
                                        lp: c["3"] || c['29'],
                                        ask: c["2"],
                                        bid: c["1"],
                                        ch: c["16"],
                                        chp: c["17"],
                                        open_price: c["15"],
                                        high_price: c["10"],
                                        low_price: c["11"],
                                        prev_close_price: c["12"],
                                        volume: c["6"],
                                        rtc: c["3"] || c['29'],
                                    };
                                    break;

                                default:
                                    break;
                            }

                            if (!quote.v) {
                                quote.v = {};
                            }

                            for (const [fieldKey, val] of Object.entries(rawData)) {
                                const isValid = val !== undefined && val !== null && !Number.isNaN(val) && val !== 0;

                                if (isValid) {
                                    quote.v[fieldKey] = val;
                                } else if (quote.v[fieldKey] === undefined || quote.v[fieldKey] === null) {
                                    if (val !== undefined && val !== null && !Number.isNaN(val)) {
                                        quote.v[fieldKey] = val;
                                    }
                                }
                            }
                            this.#CACHE_quote.set(key, quote);



                            const v = quote.v;
                            const price = v.rtc
                            const totalVolume = v.volume;

                            //update pl
                            const targetPosition = this.#CACHE_positions?.find(p => String(p.id) === key);
                            if (targetPosition) {
                                const multiplier = /\s/.test(key) ? 100 : 1;
                                const avgPrice = Number(targetPosition.avgPrice || 0);
                                const qty = Number(targetPosition.qty || 0);
                                const side = Number(targetPosition.side || 1);
                                const pl = (price - avgPrice) * qty * side * multiplier;
                                targetPosition.pl = Number(pl.toFixed(2));

                                this.#HOST.positionUpdate(targetPosition)
                            }

                            //update quote & bars
                            const SUBs = this.#SUB_pool.get(key);
                            if (SUBs) {
                                const quotePayload = [quote];
                                const inRegularHours = isInRegularTradingHours();
                                for (const sub of SUBs) {
                                    if (sub.guid.includes('_#_')) {
                                        if (sub.guid.includes('regular') && !inRegularHours) continue

                                        const resolution = sub.guid.split('_#_').pop();
                                        const cacheKey = `${key}-${resolution}`;
                                        const barTime = calculateBarTime(ts, resolution);

                                        const lastBar = this.#CACHE_LastBar.get(cacheKey);
                                        let currentBar;

                                        this.#CACHE_BarStartVolume ??= new Map();
                                        let volInfo = this.#CACHE_BarStartVolume.get(cacheKey);

                                        if (!lastBar || lastBar.time !== barTime) {
                                            currentBar = { time: barTime, open: price, high: price, low: price, close: price, volume: 0 };
                                            volInfo = { baseTotalVol: totalVolume, lastKnownTotalVol: totalVolume };
                                            this.#CACHE_BarStartVolume.set(cacheKey, volInfo);
                                        } else {
                                            volInfo ??= { baseTotalVol: totalVolume, lastKnownTotalVol: totalVolume };
                                            const volDiff = totalVolume - volInfo.lastKnownTotalVol;

                                            currentBar = {
                                                time: lastBar.time,
                                                open: lastBar.open,
                                                high: Math.max(lastBar.high, price),
                                                low: Math.min(lastBar.low, price),
                                                close: price,
                                                volume: lastBar.volume + (volDiff > 0 ? volDiff : 0)
                                            };

                                            if (volDiff > 0) {
                                                volInfo.lastKnownTotalVol = totalVolume;
                                            }
                                        }

                                        this.#CACHE_LastBar.set(cacheKey, currentBar);
                                        sub.callback(currentBar);
                                    } else {
                                        sub.callback(quotePayload);
                                    }
                                }
                            }
                        });
                    }
                },
                {
                    match: service => service === 'ACCT_ACTIVITY',
                    handle: (i) => {
                        const eventStatusMap = {
                            // 'OrderCreated': 4,

                            // Working (6)
                            'OrderAccepted': 6,
                            // 'ExecutionRequested': 6,
                            // 'ExecutionRequestCreated': 6,
                            // 'ExecutionCreated': 6,

                            'ChangeAccepted': 6,
                            // 'OrderMonitorUpdated': 6,

                            // Filled (2)
                            // 'ExecutionRequestCompleted': 2,
                            'OrderFillCompleted': 2,
                            // 'OrderMonitorCompleted': 2,

                            // Canceled (1)
                            'CancelAccepted': 1,
                            'OrderUROutCompleted': 1
                        };

                        i.content.forEach(c => {
                            let orderId = '';
                            let eventType = c['2'] || '';

                            if (c['3']) {
                                try {
                                    const payload = JSON.parse(c['3']);
                                    orderId = String(payload.SchwabOrderID || payload.orderId || '');
                                    if (payload.BaseEvent?.EventType) {
                                        eventType = payload.BaseEvent.EventType;
                                    }
                                } catch (e) {
                                    console.error('Update Order status error: ', e);
                                }
                            }

                            if (!orderId) return;

                            const targetStatus = eventStatusMap[eventType];
                            if (targetStatus === undefined) return;
                            if (!Array.isArray(this.#CACHE_orders)) this.#CACHE_orders = [];
                            const targetOrder = this.#CACHE_orders.find(o => String(o.id) === orderId);

                            if (targetOrder) {
                                targetOrder.status = targetStatus;
                                targetOrder.updateTime = Date.now();
                                let msg = findFirstKey(payload, 'NgOMSRuleDescription')
                                if (msg) {
                                    targetOrder.message = { type: 'Information', text: msg }
                                }
                                this.#HOST.orderUpdate(targetOrder);

                                const existingIndex = this.#CACHE_orders.findIndex(o => o.id === targetOrder.id);
                                if (existingIndex !== -1) {
                                    this.#CACHE_orders[existingIndex] = targetOrder;
                                }

                                if (targetStatus === 2) {
                                    this.#HOST.positionsFullUpdate();
                                }
                            } else {
                                console.warn(`Update Order status error: Can't find ID ${orderId}`);
                            }
                        });
                    }
                },
            ];


            dataList.forEach(i => {
                if (!i?.service) return;
                const handler = serviceHandlers.find(h => h.match(i.service));
                if (!handler) return;
                handler.handle(i);
            });
        });
    }

    async #initbroker() {

        const response = await fetch(`${this.#SERVER}/trader/v1/accounts/accountNumbers`);

        if (response.status !== 200) {
            this.#status = 4
            this.#HOST.connectionStatusUpdate(this.#status, `Get Broker error: ${response.status}`)
            return [];
        }

        const data = await response.json();
        this.#accounts = data.map(i => ({
            id: i.hashValue,
            name: i.accountNumber,
            type: 'live',
            currency: 'USD',
            currencySign: '$'
        }));

        this.#account = this.#accounts[0].id
        this.#status = 1
        this.#HOST.connectionStatusUpdate(this.#status)
    }

    broker(host) {
        this.#HOST = host;
        setTimeout(() => {
            this.#initbroker();
        }, 1000);
        this.#liquidationValue = this.#HOST.factory.createWatchedValue(0);
        this.#buyingPower = this.#HOST.factory.createWatchedValue(0);
        this.#cashBalance = this.#HOST.factory.createWatchedValue(0);
        return this;
    }


    // =========================================================================
    // Datafeed API 
    // =========================================================================
    onReady(callback) {
        setTimeout(() => callback({
            supported_resolutions: ['1', '5', '10', '15', '30', 'D', 'W', 'M'],
        }), 3000);
    }

    async searchSymbols(userInput, exchange, symbolType, onResult) {
        try {
            const [res1, res2] = await Promise.all([
                fetch(`${this.#SERVER}/marketdata/v1/instruments?symbol=${userInput}&projection=search`).then(r => r.json()),
                fetch(`${this.#SERVER}/marketdata/v1/instruments?symbol=${userInput}&projection=desc-search`).then(r => r.json())
            ]);

            const instruments1 = res1?.instruments ?? [];
            const instruments2 = res2?.instruments ?? [];
            const instrumentMap = new Map();
            [...instruments1, ...instruments2].forEach(item => {
                if (item && item.symbol) {
                    instrumentMap.set(item.symbol, item);
                }
            });
            const combinedInstruments = Array.from(instrumentMap.values());

            onResult(
                combinedInstruments
                    .filter(({ assetType = '' }) => {
                        const type = assetType.toLowerCase();
                        return type !== 'forex' && type !== 'index';
                    })
                    .map(({ symbol, description, exchange, assetType = '' }) => ({
                        symbol: symbol.includes(':') ? symbol.split(':')[0].slice(0, -3) : symbol,
                        description,
                        exchange,
                        type: assetType.toLowerCase(),
                    }))
            );
        } catch (error) {
            console.error("search Symbols error:", error);
            onResult([]);
        }
    }

    async resolveSymbol(symbolName, onResolve, onError, extension) {

        const subsessionsMap = new Map(Object.entries({
            "EQUITY": [
                { description: "Regular Trading Hours", id: "regular", session: "0930-1600" },
                { description: "Extended Trading Hours", id: "extended", session: "0700-2000" },
                { description: "Pre-market", id: "premarket", session: "0700-0930" },
                { description: "Post-market", id: "postmarket", session: "1600-2000" },
                // { description: "Over Night", id: "night", session: "2000-0400" },
            ],
            "OPTION": [
                { description: "Regular Trading Hours", id: "regular", session: "0930-1600" }
            ],
            "FUTURE": [
                { description: "Regular Trading Hours", id: "regular", session: "0930-1615" },
                { description: "Extended Trading Hours", id: "extended", session: "1800-1700" },
                { description: "Pre-market", id: "premarket", session: "1800-0930" },
                { description: "Post-market", id: "postmarket", session: "1615-1700" },
            ],
            // "FOREX": [
            //     { description: "Regular Trading Hours", id: "regular", session: "24x7" }
            // ]
        }));

        let info = null
        if (this.#CACHE_info.has(symbolName)) {
            info = this.#CACHE_info.get(symbolName)
        } else {
            try {
                const req = await fetch(`${this.#SERVER}/marketdata/v1/quotes?symbols=${symbolName}`).then(r => r.json());
                info = Object.values(req)[0];
                if (info.quote) {
                    const q = info.quote
                    const quote = {
                        s: 'ok',
                        n: symbolName,
                        v: Object.fromEntries(
                            Object.entries({
                                short_name: info.assetMainType === 'OPTION' ? info?.reference?.description : symbolName,
                                exchange: info?.reference?.exchangeName,
                                description: info?.reference?.description ?? symbolName,
                                lp: info?.regular?.regularMarketLastPrice ?? q.lastPrice ?? q.mark,
                                ask: q.askPrice,
                                bid: q.bidPrice,
                                open_price: q.openPrice,
                                high_price: q.highPrice,
                                low_price: q.lowPrice,
                                prev_close_price: q.closePrice,
                                volume: q.totalVolume,
                                ch: info.regular?.regularMarketNetChange ?? q.netChange,
                                chp: info.regular?.regularMarketPercentChange ?? q.futurePercentChange ?? q.netPercentChange,
                                rtc: q.lastPrice ?? q.mark,
                                rtc_time: Math.round(Number(q.quoteTime || q.tradeTime) / 1000),
                                rch: q.postMarketChange,
                                rchp: q.postMarketPercentChange,
                            }).filter(([_, v]) => v !== undefined)
                        )
                    };
                    this.#CACHE_info.set(symbolName, info)
                    this.#CACHE_quote.set(symbolName, quote)
                }
            } catch (error) {
                console.error(error)
                onError(error);
            }
        }
        try {
            const session_type = extension?.session || "regular";
            const subsessions = subsessionsMap.get(info.assetMainType)
            const symbolInfo = {
                name: symbolName,
                description: info.reference.description,
                timezone: 'America/New_York',
                type: info.assetMainType,
                exchange: info.reference.exchangeName,
                listed_exchange: info.reference.exchange,
                format: 'price',
                minmov: info.quote?.tick ? Math.round(info.quote.tick * Math.pow(10, String(info.quote.tick).split('.')[1]?.length || 0)) : 1,
                pricescale: 100,
                has_intraday: true,
                has_weekly_and_monthly: true,
                data_status: info?.realtime ? "streaming" : "delayed_streaming",
                currency_code: 'USD',
                subsession_id: session_type,
                session: subsessions.find(s => s.id === session_type)?.session ?? '24x7',
                subsessions,
            };

            setTimeout(() => {
                onResolve(symbolInfo);
            }, 0);

        } catch (e) {
            console.error(e)
            onError(e);
        }
    }

    async getQuotes(symbols, onDataCallback, onErrorCallback) {
        try {
            const promises = symbols.map(async (symbolName) => {
                return this.#CACHE_quote.get(symbolName) || {};
            });
            const data = await Promise.all(promises);
            onDataCallback(data);
        } catch (e) {
            onErrorCallback(e);
        }
    }

    async getBars(symbolInfo, resolution, periodParams, onResult, onError) {
        const { from, to, countBack, firstDataRequest } = periodParams;

        if (from < 0 || to < 0 || from >= to) {
            onError(`Get Bars E:${from} to ${to}`)
            return;
        }

        try {

            const timeSpan = to - from;
            const paddedFrom = Math.floor(from - timeSpan * 0.5);

            const getFreqConfig = (res, startTimestamp) => {
                const upperRes = String(res).toUpperCase();

                const nowSeconds = Math.floor(Date.now() / 1000);
                const historyAgeSeconds = Math.max(0, nowSeconds - startTimestamp);
                const days = historyAgeSeconds / 86400;
                const years = days / 365;

                if (['M', '1M'].includes(upperRes)) {
                    let period = 1;
                    if (years > 15) period = 20;
                    else if (years > 10) period = 15;
                    else if (years > 5) period = 10;
                    else if (years > 3) period = 5;
                    else if (years > 2) period = 3;
                    else if (years > 1) period = 2;
                    return { frequencyType: 'monthly', frequency: 1, periodType: 'year', period };
                }

                if (['W', '1W'].includes(upperRes)) {
                    let period = 1;
                    if (years > 15) period = 20;
                    else if (years > 10) period = 15;
                    else if (years > 5) period = 10;
                    else if (years > 3) period = 5;
                    else if (years > 2) period = 3;
                    else if (years > 1) period = 2;
                    return { frequencyType: 'weekly', frequency: 1, periodType: 'year', period };
                }

                if (['D', '1D'].includes(upperRes)) {
                    let period = 1;
                    if (years > 15) period = 20;
                    else if (years > 10) period = 15;
                    else if (years > 5) period = 10;
                    else if (years > 3) period = 5;
                    else if (years > 2) period = 3;
                    else if (years > 1) period = 2;
                    return { frequencyType: 'daily', frequency: 1, periodType: 'year', period };
                }

                let frequency = parseInt(upperRes, 10) || 1;
                if (![1, 5, 10, 15, 30].includes(frequency)) {
                    frequency = 1;
                }

                let period = 1;
                if (days > 5) period = 10;
                else if (days > 3) period = 5;
                else if (days > 1) period = 3;
                else period = 1;

                return { frequencyType: 'minute', frequency, periodType: 'day', period };
            };

            const { frequencyType, frequency, periodType, period } = getFreqConfig(resolution, paddedFrom);

            const queryParams = new URLSearchParams({
                symbol: symbolInfo.name,
                startDate: paddedFrom * 1000,
                endDate: to * 1000,
                periodType,
                period,
                frequencyType,
                frequency,
                needExtendedHoursData: symbolInfo.subsession_id !== 'regular' ? 'true' : 'false',
                needPreviousClose: 'false'
            });

            const url = `${this.#SERVER}/marketdata/v1/pricehistory?${queryParams.toString()}`;
            const response = await fetch(url);

            if (!response.ok) {
                const errText = await response.text();
                onError(`Get Bars E: [${errText}]:`)
                return;
            }

            const res = await response.json();

            if (!res || res.empty === true || !Array.isArray(res.candles) || res.candles.length === 0) {
                onResult([], { noData: true });
                return;
            }

            const barMap = new Map();

            for (const bar of res.candles) {
                const timestamp = Number(bar.datetime || bar.time);
                if (isNaN(timestamp)) continue;

                const open = Number(bar.open);
                const high = Number(bar.high);
                const low = Number(bar.low);
                const close = Number(bar.close);
                const volume = Number(bar.volume || 0);

                if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;

                const validHigh = Math.max(high, open, close);
                const validLow = Math.min(low, open, close);

                barMap.set(timestamp, {
                    time: timestamp,
                    open,
                    high: validHigh,
                    low: validLow,
                    close,
                    volume
                });
            }


            const rawBars = Array.from(barMap.values()).sort((a, b) => a.time - b.time);
            const cleanBars = [];
            let lastTime = -1;
            for (const bar of rawBars) {
                if (bar.time > lastTime) {
                    cleanBars.push(bar);
                    lastTime = bar.time;
                }
            }

            if (firstDataRequest && cleanBars.length > 0) {
                const lastBar = cleanBars[cleanBars.length - 1];
                const cacheKey = `${symbolInfo.name}-${resolution}`;
                this.#CACHE_LastBar.set(cacheKey, lastBar);
            }

            onResult(cleanBars, { noData: cleanBars.length < countBack });

        } catch (error) {
            onError(`Get Bars E:${error}`)
        }
    }

    #SERVICE_FIELDS = {
        'LEVELONE_EQUITIES': '0,1,2,3,8,10,11,12,17,18,29,31,33,34,42,43,44,45,50,51',
        'LEVELONE_OPTIONS': '0,2,3,4,5,6,7,8,15,19,44,45,46',
        'LEVELONE_FUTURES': '0,1,2,3,8,10,12,13,14,18,19,20,24,25,31',
        'LEVELONE_FUTURES_OPTIONS': '0,1,2,3,8,10,12,13,14,17,19',
        'LEVELONE_FOREX': '0,1,2,3,6,8,10,11,12,15,16,17,29'
    };

    #classifySymbol(sym) {
        const cleanSym = sym.includes(':') ? sym.split(':')[1] : sym;
        if (cleanSym.startsWith('./')) return 'LEVELONE_FUTURES_OPTIONS';
        if (cleanSym.startsWith('/')) return 'LEVELONE_FUTURES';
        if (cleanSym.includes(' ')) return 'LEVELONE_OPTIONS';
        if (cleanSym.includes('/')) return 'LEVELONE_FOREX';
        return 'LEVELONE_EQUITIES';
    }


    async subscribeQuotes(symbols, fastSymbols, onRealtimeCallback, listenerGUID) {
        const allSymbols = [...new Set([...symbols, ...fastSymbols])];
        if (allSymbols.length === 0) return;

        const networkKeysByType = {};
        const now = Date.now();
        const COOLDOWN_MS = 60000;

        for (const key of allSymbols) {
            const service = this.#classifySymbol(key);

            this.#SUB_guid.set(listenerGUID, { key, service });

            if (!this.#SUB_pool.has(key)) {
                this.#SUB_pool.set(key, new Set());
            }
            this.#SUB_pool.get(key).add({ guid: listenerGUID, callback: onRealtimeCallback });

            if (now - (this.#SUB_cooldown.get(key) || 0) >= COOLDOWN_MS) {
                if (!networkKeysByType[service]) networkKeysByType[service] = [];
                networkKeysByType[service].push(key);
                this.#SUB_cooldown.set(key, now);
            }
        }

        for (const [service, keysList] of Object.entries(networkKeysByType)) {
            if (keysList.length === 0) continue;

            try {
                const response = await fetch(`${this.#SERVER}/command`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        service,
                        command: "ADD",
                        parameters: {
                            keys: keysList.join(','),
                            fields: this.#SERVICE_FIELDS[service]
                        }
                    })
                });

                if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            } catch (err) {
                console.error(`sub quote E: [${service}]:`, err.message || err);
                keysList.forEach(sym => this.#SUB_cooldown.delete(sym));
            }
        }
    }

    async unsubscribeQuotes(listenerGUID) {
        if (!this.#SUB_guid.has(listenerGUID)) return;

        const { key, service } = this.#SUB_guid.get(listenerGUID);
        this.#SUB_guid.delete(listenerGUID);

        if (!key || !this.#SUB_pool.has(key)) return;

        const subsSet = this.#SUB_pool.get(key);
        for (const item of subsSet) {
            if (item.guid === listenerGUID) {
                subsSet.delete(item);
                break;
            }
        }

        if (subsSet.size === 0) {
            this.#SUB_pool.delete(key);
            try {
                await fetch(`${this.#SERVER}/command`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        service,
                        command: "UNSUBS",
                        parameters: { keys: key, fields: '0' }
                    })
                });
            } catch (err) {
                console.error(`sub quote E:[${service}]`, err);
            }
        }
    }

    subscribeBars(symbolInfo, resolution, onTick, listenerGUID) {
        const key = symbolInfo.name;
        if (!this.#SUB_pool.has(key)) {
            this.#SUB_pool.set(key, new Set());
        }
        this.#SUB_pool.get(key).add({ guid: listenerGUID, callback: onTick });
    }

    unsubscribeBars(listenerGUID) {
        for (const [key, subsSet] of this.#SUB_pool.entries()) {
            for (const item of subsSet) {
                if (item.guid === listenerGUID) {
                    subsSet.delete(item);
                    if (subsSet.size === 0) {
                        this.#SUB_pool.delete(key);
                    }
                    return;
                }
            }
        }
    }

    // =========================================================================
    // Broker
    // =========================================================================
    connectionStatus() {
        return this.#status
    }

    currentAccount() {
        return this.#account
    }

    setCurrentAccount(id) {
        this.#account = id
    }
    async accountsMetainfo() {
        return this.#accounts
    }


    async chartContextMenuActions(context, options) {
        const defaultActions = await this.#HOST.defaultContextMenuActions(context);
        const customActions = [
            {
                text: `Positions`,
                action: () => {
                    this.#HOST.positionsFullUpdate()
                },
                icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><g fill="none" fill-rule="evenodd" stroke="currentColor"><path d="M6.5 15A8.5 8.5 0 1 0 15 6.5H8.5"></path><path d="M12 10L8.5 6.5 12 3"></path></g></svg>',
            },
            {
                text: `Orders`,
                action: () => {
                    this.#HOST.ordersFullUpdate()
                },
                icon: '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><g fill="none" fill-rule="evenodd" stroke="currentColor"><path d="M6.5 15A8.5 8.5 0 1 0 15 6.5H8.5"></path><path d="M12 10L8.5 6.5 12 3"></path></g></svg>',
            }]
        return [

            ...defaultActions,
            ...customActions,
        ];
    }
    async isTradable(symbol) {
        const isEquity = /^[A-Za-z]+$/.test(symbol);
        const isOption = symbol.includes(' ');
        const tradable = isEquity || isOption;
        return {
            tradable,
            ...(!tradable && {
                reason: `Unsupported symbol. API only supports [stocks] and [options].`
            })
        };
    }
    async symbolInfo(symbol) {
        const hasSpace = symbol.includes(' ');
        return {
            qty: {
                min: 1,
                max: 9999999,
                step: 1
            },
            pipValue: hasSpace ? 1 : 0.01,
            pipSize: hasSpace ? 1 : 0.01,
            minTick: 0.01,
            currency: 'USD',
        };
    }
    async executions(symbol) {
        const cleanSymbol = (symbol || '').toUpperCase().trim();
        if (!/^[A-Z]+$/.test(cleanSymbol)) return [];
        const now = new Date();
        const oneYearAgo = new Date(now);
        oneYearAgo.setFullYear(now.getFullYear() - 1);

        const url = `${this.#SERVER}/trader/v1/accounts/${this.#account}/transactions?startDate=${oneYearAgo.toISOString()}&endDate=${now.toISOString()}&symbol=${encodeURIComponent(symbol)}&types=TRADE`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Get executions E: ${response.status}`);
        }

        const data = await response.json();

        const list = data.map((i) => {
            const tradeItem = i.transferItems?.find(item => !item.feeType) || {};
            const instrument = tradeItem.instrument || {};
            const commissionItem = i.transferItems?.find(item => item.feeType === 'COMMISSION') || {};
            const otherFees = i.transferItems?.filter(item => item.feeType && item.feeType !== 'COMMISSION') || [];
            const totalFee = otherFees.reduce((sum, item) => sum + (item.amount || 0), 0);

            return {
                id: String(i.activityId),
                symbol: instrument.symbol || '',
                price: tradeItem.price || 0,
                qty: Math.abs(tradeItem.amount || 0),
                side: (tradeItem.amount > 0) ? 1 : -1,
                time: new Date(i.time).getTime(),
                commission: commissionItem.amount || 0,
                fee: totalFee,
                netAmount: i.netAmount || 0,
            };
        });
        return list;
    }

    async orders() {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 12 * 60 * 60 * 1000);

        const url = `${this.#SERVER}/trader/v1/accounts/${this.#account}/orders?fromEnteredTime=${yesterday.toISOString()}&toEnteredTime=${now.toISOString()}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Get orders E: ${response.status}`);
        }

        const data = await response.json();
        if (!Array.isArray(data)) return [];

        const result = [];


        const mapOrderStatus = (statusStr) => {
            if (!statusStr) return 4;
            const s = statusStr.toUpperCase();

            if (s === 'CANCELED' || s === 'EXPIRED') return 1;              // Canceled = 1
            if (s === 'FILLED') return 2;                                   // Filled = 2
            if (s.includes('AWAITING_PARENT_ORDER')) return 3;              // Inactive = 3
            if (s === 'REJECTED') return 5;                                 // Rejected = 5
            if (s === 'WORKING' || s === 'QUEUED' || s === 'ACCEPTED' || s === 'PENDING_ACTIVATION') return 6; // Working = 6

            return 4;
        };

        const mapOrderType = (typeStr) => {
            if (!typeStr) return 1;
            const t = typeStr.toUpperCase();
            if (t === 'LIMIT') return 1;
            if (t === 'MARKET') return 2;
            if (t === 'STOP') return 3;
            if (t === 'STOP_LIMIT') return 4;
            return 1;
        };

        const parseNode = (node, currentParentId = null, currentParentType = 1) => {
            if (!node) return;

            const strategyType = (node.orderStrategyType || '').toUpperCase();
            if (!['SINGLE', 'OCO'].includes(strategyType)) return
            const legs = node.orderLegCollection || [];
            const leg = legs[0] || {};
            const instrument = leg.instrument || {};
            const symbol = instrument.symbol || '';

            if (strategyType === 'OCO' && legs.length === 0) {
                if (node.childOrderStrategies && Array.isArray(node.childOrderStrategies)) {
                    node.childOrderStrategies.forEach(child => {
                        const childLeg = child.orderLegCollection?.[0] || {};
                        const childSymbol = childLeg.instrument?.symbol || symbol;

                        const nextParentId = currentParentId !== null ? currentParentId : childSymbol;
                        const nextParentType = currentParentId !== null ? currentParentType : 2;

                        parseNode(child, nextParentId, nextParentType);
                    });
                }
                return;
            }


            const orderId = node.orderId ? String(node.orderId) : '';
            const instruction = (leg.instruction || 'BUY').toUpperCase();
            const isBuy = instruction === 'BUY' || instruction.includes('BUY');

            let updateTime = Date.now();
            if (node.enteredTime) {
                const standardizedTime = node.enteredTime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
                const parsedDate = new Date(standardizedTime);
                if (!isNaN(parsedDate.getTime())) {
                    updateTime = parsedDate.getTime();
                }
            }

            const tvOrder = {
                id: orderId,
                symbol: symbol,
                type: mapOrderType(node.orderType),
                side: isBuy ? 1 : -1,
                qty: Number(node.quantity || leg.quantity || 1),
                status: mapOrderStatus(node.status),
                filledQty: Number(node.filledQuantity || 0),
                avgPrice: Number(node.averagePrice || 0),
                updateTime: updateTime,
                limitPrice: node.price !== undefined ? Number(node.price) : undefined,
                stopPrice: node.stopPrice !== undefined ? Number(node.stopPrice) : undefined,
                message: node.statusDescription ? { type: 'Information', text: node.statusDescription } : undefined,
                parentId: currentParentId !== null && currentParentId !== undefined ? String(currentParentId) : undefined,
                parentType: currentParentId !== null && currentParentId !== undefined ? currentParentType : undefined
            };

            result.push(tvOrder);

            if (node.childOrderStrategies && Array.isArray(node.childOrderStrategies)) {
                const nextParentId = orderId || currentParentId;
                const nextParentType = orderId ? 1 : currentParentType;
                node.childOrderStrategies.forEach(child => parseNode(child, nextParentId, nextParentType));
            }
        };

        data.forEach(rootNode => {
            parseNode(rootNode, null, 1);
        });

        this.#CACHE_orders = result;
        return result;
    }
    async positions() {
        const response = await fetch(`${this.#SERVER}/trader/v1/accounts/${this.#account}?fields=positions`);
        if (!response.ok) {
            throw new Error(`Get positions E: ${response.status}`);
        }

        const data = await response.json();


        const securitiesAccount = data.securitiesAccount || data;

        const currentBalances = securitiesAccount?.currentBalances || null;
        if (currentBalances) {
            this.#liquidationValue.setValue(currentBalances.liquidationValue ?? 0);
            this.#buyingPower.setValue(currentBalances.buyingPower ?? 0);
            this.#cashBalance.setValue(currentBalances.cashBalance ?? 0);
        }

        const list = securitiesAccount.positions || data.positions;

        if (!Array.isArray(list)) return [];

        const result = list.map((i) => {
            const instrument = i.instrument || {};
            const symbol = instrument.uniformSymbol || instrument.symbol || '';

            const longQty = Number(i.longQuantity || 0);
            const shortQty = Number(i.shortQuantity || 0);

            let qty = 0;
            let side = 1;
            let avgPrice = Number(i.averagePrice || 0);

            if (longQty > 0) {
                qty = longQty;
                side = 1;
                avgPrice = Number(i.averageLongPrice || i.taxLotAverageLongPrice || i.averagePrice || 0);
            } else if (shortQty > 0) {
                qty = shortQty;
                side = -1;
                avgPrice = Number(i.averageShortPrice || i.averagePrice || 0);
            }

            return {
                id: symbol,
                symbol: symbol,
                qty: qty,
                side: side,
                avgPrice: avgPrice,
                marketValue: i.marketValue,
            };
        }).filter(p => p.qty > 0);
        this.#CACHE_positions = result
        return result;
    }

    async editPositionBrackets(positionId, brackets, customFields = {}) {
        const positionsList = Array.isArray(this.#CACHE_positions) ? this.#CACHE_positions : [];
        const p = positionsList.find(item => item.id === positionId || item.symbol === positionId) ?? { symbol: positionId, qty: 1, side: 1 };
        const symbol = p.symbol || positionId;
        const qty = Number(p.qty ?? 1);

        const isLong = [1, 'BUY', 'long'].includes(p.side);
        const isOption = /\s/.test(symbol);
        const assetType = isOption ? 'OPTION' : 'EQUITY';
        const instruction = isOption ? (isLong ? 'SELL_TO_CLOSE' : 'BUY_TO_CLOSE') : (isLong ? 'SELL' : 'BUY');

        const tpPrice = brackets.takeProfit !== undefined ? Number(brackets.takeProfit).toFixed(2) : undefined;
        const slPrice = brackets.stopLoss !== undefined ? Number(brackets.stopLoss).toFixed(2) : undefined;
        p.takeProfit = tpPrice !== undefined ? Number(tpPrice) : undefined;
        p.stopLoss = slPrice !== undefined ? Number(slPrice) : undefined;

        const ordersList = Array.isArray(this.#CACHE_orders) ? this.#CACHE_orders : [];
        const activeStatuses = [6];

        const existingOrders = ordersList.filter(order => {
            const isMatch = order.parentId === positionId ||
                order.symbol === symbol ||
                order.orderLegCollection?.some(leg => leg.instrument?.symbol === symbol);

            return isMatch && activeStatuses.includes(Number(order.status));
        });

        const tpOrder = existingOrders.find(order =>
            Number(order.type) === 1 || order.orderType === 'LIMIT' || order.type === 'LIMIT'
        );
        const slOrder = existingOrders.find(order =>
            Number(order.type) === 3 || order.orderType === 'STOP' || order.type === 'STOP'
        );


        const modifyOrderFn = async (order) => {
            await this.modifyOrder(order);
        };

        if (tpPrice !== undefined) {
            if (tpOrder) {
                const currentTpPrice = Number(tpOrder.price ?? tpOrder.limitPrice ?? 0);
                if (Math.abs(currentTpPrice - Number(tpPrice)) > 0.001) {
                    tpOrder.price = Number(tpPrice);
                    if (tpOrder.limitPrice !== undefined) tpOrder.limitPrice = Number(tpPrice);
                    await modifyOrderFn(tpOrder);
                }
            }
        }

        if (slPrice !== undefined) {
            if (slOrder) {
                const currentSlPrice = Number(slOrder.stopPrice ?? slOrder.price ?? 0);
                if (Math.abs(currentSlPrice - Number(slPrice)) > 0.001) {
                    slOrder.stopPrice = Number(slPrice);
                    if (slOrder.price !== undefined && slOrder.stopPrice === undefined) slOrder.price = Number(slPrice);
                    await modifyOrderFn(slOrder);
                }
            }
        }

        if (existingOrders.length === 0 && (tpPrice !== undefined || slPrice !== undefined)) {
            const childStrategies = [];

            if (tpPrice !== undefined) {
                childStrategies.push({
                    orderType: 'LIMIT', session: 'SEAMLESS', duration: 'GOOD_TILL_CANCEL',
                    price: tpPrice,
                    orderStrategyType: 'SINGLE',
                    orderLegCollection: [{ instruction, quantity: qty, instrument: { symbol, assetType } }]
                });
            }

            if (slPrice !== undefined) {
                childStrategies.push({
                    orderType: 'STOP', session: 'NORMAL', duration: 'GOOD_TILL_CANCEL',
                    stopPrice: slPrice,
                    orderStrategyType: 'SINGLE',
                    orderLegCollection: [{ instruction, quantity: qty, instrument: { symbol, assetType } }]
                });
            }

            if (childStrategies.length > 0) {
                const schwabPayload = childStrategies.length > 1 ? {
                    orderStrategyType: 'OCO',
                    childOrderStrategies: childStrategies
                } : childStrategies[0];

                const response = await fetch(`${this.#SERVER}/trader/v1/accounts/${this.#account}/orders`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify(schwabPayload)
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`editPositionBrackets E: (${response.status}): ${errorText}`);
                }
            }

            setTimeout(() => {
                this.#HOST.ordersFullUpdate();
            }, 1000);
        }

        this.#HOST.positionUpdate(p);
    }

    async placeOrder(order, confirmId) {
        if (order.isClose) {
            const positionsList = Array.isArray(this.#CACHE_positions) ? this.#CACHE_positions : [];
            const p = positionsList.find(item => item.id === order.symbol) ?? { symbol: positionId, qty: 1, side: 1 };
            p.updateTime = Date.now()
            p.qty = 0
            this.#HOST.positionUpdate(p)
        }

        const schwabPayload = order_build(order);
        const response = await fetch(`${this.#SERVER}/trader/v1/accounts/${this.#account}/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(schwabPayload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`place Order E: (${response.status}): ${errorText}`);
        }
        const location = response.headers.get('Location');
        if (location) {

            const parts = location.split('/').filter(Boolean);
            const orderId = parts[parts.length - 1];

            if (orderId) {
                order.id = String(orderId);
                order.status = 4;
                this.#CACHE_orders.push(order)
                this.#HOST.orderUpdate(order)
                return orderId
            }
        }
    }

    async modifyOrder(order, confirmId) {
        const oldOrderId = String(order.id);
        const schwabPayload = order_build(order);

        const response = await fetch(`${this.#SERVER}/trader/v1/accounts/${this.#account}/orders/${order.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(schwabPayload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`modify Order E: (${response.status}): ${errorText}`);
        }

        const location = response.headers.get('Location');
        if (location) {
            const parts = location.split('/').filter(Boolean);
            const newOrderId = parts[parts.length - 1];

            if (newOrderId) {
                const oldOrderIndex = this.#CACHE_orders.findIndex(o => o.id === oldOrderId);
                if (oldOrderIndex !== -1) {
                    const oldOrder = this.#CACHE_orders[oldOrderIndex];
                    oldOrder.status = 4;
                    this.#HOST.orderUpdate(oldOrder);
                }

                const newOrder = {
                    ...order,
                    id: String(newOrderId),
                    status: 4
                };

                this.#CACHE_orders.push(newOrder);
                this.#HOST.orderUpdate(newOrder);
            }
        }
    }

    async cancelOrder(orderId) {

        const response = await fetch(`${this.#SERVER}/trader/v1/accounts/${this.#account}/orders/${orderId}`, { method: 'DELETE' });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`cancel Order E: (${response.status}): ${errorText}`);
        }

        const order = this.#CACHE_orders.find(o => o.id === String(orderId));
        if (order) {
            order.status = 1;
            this.#HOST.orderUpdate(order);
        }
    }

    accountManagerInfo() {
        return {
            accountTitle: "SCHWAB",
            summary: [
                {
                    text: "Equity",
                    wValue: this.#liquidationValue,
                    formatter: "fixed",
                    isDefault: true,
                },
                {
                    text: "Buying Power",
                    wValue: this.#buyingPower,
                    formatter: "fixed",
                    isDefault: true,
                },
                {
                    text: "Cash",
                    wValue: this.#cashBalance,
                    formatter: "fixed",
                    isDefault: true,
                }
            ],
            orderColumns: [
                {
                    label: 'Symbol',
                    formatter: "symbol",
                    id: 'symbol',
                    dataFields: ['symbol'],
                },
                {
                    label: 'status',
                    id: 'status',
                    dataFields: ['status'],
                    formatter: "status"
                },
                {
                    label: 'Side',
                    id: 'side',
                    dataFields: ['side'],
                    formatter: "side"
                },
                {
                    label: 'Qty',
                    alignment: 'right',
                    id: 'qty',
                    dataFields: ['qty'],
                    formatter: "formatQuantity"
                },

                {
                    label: 'type',
                    id: 'type',
                    dataFields: ['type', "parentId"],
                    formatter: "type"
                },
                {
                    label: 'limitPrice',
                    alignment: 'right',
                    id: 'limitPrice',
                    dataFields: ['limitPrice'],
                    formatter: "formatPrice"
                },
                {
                    label: 'stopPrice',
                    alignment: 'right',
                    id: 'stopPrice',
                    dataFields: ['stopPrice'],
                    formatter: "formatPrice"
                },
                // {
                //     label: 'filledQty',
                //     alignment: 'right',
                //     id: 'filledQty',
                //     dataFields: ['filledQty'],
                //     formatter: "formatQuantity"
                // },
                // {
                //     label: 'avgPrice',
                //     alignment: 'right',
                //     id: 'avgPrice',
                //     dataFields: ['avgPrice'],
                //     formatter: "formatPrice"
                // },
                // {
                //     label: 'date',
                //     id: 'date',
                //     dataFields: ['date'],
                //     formatter: "date"
                // },
                {
                    label: 'id',
                    id: 'id',
                    dataFields: ['id'],
                },
            ],
            positionColumns: [
                {
                    label: 'Symbol',
                    formatter: "symbol",
                    id: 'symbol',
                    dataFields: ['symbol'],
                },
                {
                    label: 'Side',
                    id: 'side',
                    dataFields: ['side'],
                    formatter: "side"
                },
                {
                    label: 'Qty',
                    id: 'qty',
                    dataFields: ['qty'],
                    formatter: "formatQuantity"
                },
                {
                    label: 'marketValue',
                    id: 'marketValue',
                    dataFields: ['marketValue', 'currency'],
                    formatter: "fixedInCurrency"
                },
                {
                    label: 'avgPrice',
                    id: 'avgPrice',
                    dataFields: ['avgPrice'],
                    formatter: "formatPrice"
                },
                {
                    label: 'PL',
                    alignment: 'right',
                    id: 'pl',
                    dataFields: ['pl', 'currency'],
                    formatter: "profitInInstrumentCurrency"
                },
            ],
            pages: [],
        };
    }

}


function order_build(o) {
    const symbol = o.symbol;
    const qty = Number(o.qty ?? o.quantity ?? 1);
    const isBuy = Number(o.side) === 1;
    const isOption = /\s/.test(symbol);
    const assetType = isOption ? 'OPTION' : 'EQUITY';
    const session = isOption ? 'NORMAL' : (Number(o.type) === 1 ? 'SEAMLESS' : 'NORMAL');
    const instruction = isOption
        ? (isBuy ? 'BUY_TO_OPEN' : 'SELL_TO_CLOSE')
        : (isBuy ? 'BUY' : 'SELL');

    const typeMap = { 1: 'LIMIT', 2: 'MARKET', 3: 'STOP', 4: 'STOP_LIMIT' };
    const orderType = typeMap[o.type] ?? 'LIMIT';

    const orderPayload = {
        orderStrategyType: 'SINGLE',
        duration: 'DAY',
        session,
        orderType,
        orderLegCollection: [{
            instruction,
            quantity: qty,
            instrument: { symbol, assetType }
        }]
    };

    const typeNum = Number(o.type);
    const price = o.limitPrice ?? o.price;

    if (typeNum === 1 && price !== undefined) {
        orderPayload.price = Number(price).toFixed(2);
    } else if (typeNum === 3 && o.stopPrice !== undefined) {
        orderPayload.stopPrice = Number(o.stopPrice).toFixed(2);
    } else if (typeNum === 4) {
        if (o.stopPrice !== undefined) orderPayload.stopPrice = Number(o.stopPrice).toFixed(2);
        if (price !== undefined) orderPayload.price = Number(price).toFixed(2);
    }

    return orderPayload;
}

function calculateBarTime(timestamp, resolution) {
    const date = new Date(timestamp);

    switch (resolution) {
        case 'D':
        case '1D':
            date.setHours(0, 0, 0, 0);
            return date.getTime();

        case 'W':
        case '1W': {
            date.setHours(0, 0, 0, 0);
            const day = date.getDay();
            const diff = date.getDate() - day + (day === 0 ? -6 : 1);
            date.setDate(diff);
            return date.getTime();
        }

        case 'M':
        case '1M':

            date.setDate(1);
            date.setHours(0, 0, 0, 0);
            return date.getTime();

        default: {
            const minutes = parseInt(resolution, 10);
            const intervalMs = (!isNaN(minutes) && minutes > 0 ? minutes : 1) * 60 * 1000;
            return Math.floor(timestamp / intervalMs) * intervalMs;
        }
    }
}

function isInRegularTradingHours() {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour12: false,
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric'
    });

    const parts = formatter.formatToParts(new Date());
    let weekday = '', hour = 0, minute = 0;

    for (const p of parts) {
        if (p.type === 'weekday') weekday = p.value;
        if (p.type === 'hour') hour = parseInt(p.value, 10);
        if (p.type === 'minute') minute = parseInt(p.value, 10);
    }

    if (weekday === 'Sun' || weekday === 'Sat') {
        return false;
    }

    const timeVal = hour * 100 + minute;
    return timeVal >= 930 && timeVal <= 1600;
}