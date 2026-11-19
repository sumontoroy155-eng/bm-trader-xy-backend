import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TD_KEY = process.env.TWELVE_DATA_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const SYMBOLS = (process.env.MARKETS || 'EUR/USD,GBP/USD,USD/JPY,AUD/USD,USD/CAD,EUR/JPY,GBP/JPY,NZD/USD,USD/CHF')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const cache = new Map();
const intervalMap = { '1m':'1min', '5m':'5min', '15m':'15min', '1h':'1h' };

// Basic production protections. Add a proper Redis-backed limiter if scaling to multiple instances.
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  }
}));
app.use(express.json({ limit: '64kb' }));

const requestCounts = new Map();
app.use('/api', (req, res, next) => {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const item = requestCounts.get(key) || { start: now, count: 0 };
  if (now - item.start > 60_000) { item.start = now; item.count = 0; }
  item.count += 1;
  requestCounts.set(key, item);
  if (item.count > 90) return res.status(429).json({ error: 'অনেক বেশি request হয়েছে। এক মিনিট পরে আবার চেষ্টা করুন।' });
  next();
});
function fail(res, status, message) { return res.status(status).json({ error: message }); }
function validSymbol(s) { return /^[A-Z]{3}\/[A-Z]{3}$/.test(s || ''); }
function validTf(t) { return Object.hasOwn(intervalMap, t); }

async function getCandles(symbol, timeframe) {
  if (!TD_KEY) throw new Error('Market API key সেট করা নেই। .env-এ TWELVE_DATA_API_KEY দিন।');
  if (!validSymbol(symbol)) throw new Error('Market symbol সঠিক নয়। যেমন EUR/USD');
  if (!validTf(timeframe)) throw new Error('এই timeframe সমর্থিত নয়। 1m, 5m, 15m বা 1h ব্যবহার করুন।');
  const key = `${symbol}:${timeframe}`;
  const old = cache.get(key);
  if (old && Date.now() - old.at < 15_000) return old.data;

  const url = new URL('https://api.twelvedata.com/time_series');
  url.search = new URLSearchParams({
    symbol, interval: intervalMap[timeframe], outputsize: '150',
    timezone: 'UTC', apikey: TD_KEY
  }).toString();

  const upstream = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  const body = await upstream.json();
  if (!upstream.ok || body.status === 'error' || !Array.isArray(body.values)) {
    // Do not echo the request URL; it contains the provider API key.
    throw new Error(body.message || `Market provider error (${upstream.status})`);
  }
  const candles = body.values.slice().reverse().map(v => ({
    time: Math.floor(Date.parse(String(v.datetime).replace(' ', 'T') + 'Z') / 1000),
    open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close)
  })).filter(c => Number.isFinite(c.time) &&
    [c.open,c.high,c.low,c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close));

  if (candles.length < 30) throw new Error(`এই মার্কেটের পর্যাপ্ত candle পাওয়া যায়নি (${candles.length})`);
  const data = { candles, source: 'Twelve Data', symbol, timeframe, fetchedAt: new Date().toISOString() };
  cache.set(key, { at: Date.now(), data });
  return data;
}
function ema(values, n) {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let v = values.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for (let i=n;i<values.length;i++) v = values[i]*k + v*(1-k);
  return v;
}
function rsi(values, n=14) {
  if (values.length < n+1) return null;
  let gains=0, losses=0;
  for (let i=values.length-n;i<values.length;i++) {
    const d=values[i]-values[i-1]; if (d>0) gains+=d; else losses-=d;
  }
  if (losses===0) return 100;
  return +(100-100/(1+(gains/n)/(losses/n))).toFixed(1);
}
function analyze(symbol, candles) {
  const closes=candles.map(c=>c.close), last=candles.at(-1), prev=candles.at(-2);
  const e9=ema(closes,9), e21=ema(closes,21), rv=rsi(closes);
  if (!last || !prev || e9===null || e21===null || rv===null)
    return { symbol, price:last?.close ?? null, signal:'WAIT', bias:'UNKNOWN', risk:'UNKNOWN', reason:'পর্যাপ্ত verified candle নেই।' };
  const up=(e9>e21?1:0)+(last.close>e9?1:0)+(rv>53?1:0)+(last.close>prev.close?1:0);
  const down=(e9<e21?1:0)+(last.close<e9?1:0)+(rv<47?1:0)+(last.close<prev.close?1:0);
  const bias=up>=3?'BULLISH':down>=3?'BEARISH':'SIDEWAYS';
  const signal=up===4&&rv>52?'UP':down===4&&rv<48?'DOWN':'WAIT';
  const ranges=candles.slice(-14).map(c=>c.high-c.low);
  const atr=ranges.reduce((a,b)=>a+b,0)/ranges.length, candleRange=last.high-last.low;
  const body=Math.abs(last.close-last.open), wick=(candleRange-body)/(candleRange||1);
  const risk=candleRange>atr*1.8||bias==='SIDEWAYS'||wick>.7?'HIGH':'MEDIUM';
  return { symbol, price:last.close, bias, signal, rsi:rv, risk,
    reason:`EMA9 ${e9>e21?'EMA21-এর উপরে':'EMA21-এর নিচে'}, RSI ${rv}, bullish checks ${up}/4, bearish checks ${down}/4. এটি rule-based filter; win probability নয়।`,
    candle: { open:last.open, high:last.high, low:last.low, close:last.close, wickPercent:Math.round(wick*100) } };
}

app.get('/api/health', (req,res) => res.json({
  ok:true, service:'BM TRADER XY backend',
  aiConfigured:!!OPENAI_KEY, marketConfigured:!!TD_KEY,
  marketProvider:'Twelve Data', time:new Date().toISOString()
}));
app.get('/api/market', async (req,res) => {
  try {
    const symbol=String(req.query.symbol||'EUR/USD').toUpperCase();
    const timeframe=String(req.query.timeframe||'1m');
    const data=await getCandles(symbol,timeframe);
    res.set('Cache-Control','no-store').json(data);
  } catch(e) { fail(res, 400, e.message); }
});
app.get('/api/markets', async (req,res) => {
  if (!TD_KEY) return fail(res,503,'Market API key সেট করা নেই।');
  const timeframe=String(req.query.timeframe||'1m');
  if (!validTf(timeframe)) return fail(res,400,'Timeframe সমর্থিত নয়।');
  const results=await Promise.allSettled(SYMBOLS.map(async s => {
    const d=await getCandles(s,timeframe); return analyze(s,d.candles);
  }));
  const markets=results.filter(x=>x.status==='fulfilled').map(x=>x.value)
    .sort((a,b)=>({UP:0,WAIT:1,DOWN:2}[a.signal] - {UP:0,WAIT:1,DOWN:2}[b.signal]));
  const errors=results.filter(x=>x.status==='rejected').map(x=>x.reason.message);
  res.json({ markets, errors, source:'Twelve Data',
    note:'এটি সাধারণ technical scan; পরীক্ষিত সাফল্যের হার বা নিশ্চিত ranking নয়।' });
});
app.post('/api/chat', async (req,res) => {
  try {
    if (!OPENAI_KEY) return fail(res,503,'AI API key সেট করা নেই।');
    const { message, market, timeframe, candles=[], analysis } = req.body || {};
    if (typeof message!=='string' || !message.trim()) return fail(res,400,'প্রশ্ন লিখুন।');
    if (message.length>4000) return fail(res,413,'প্রশ্ন ৪০০০ অক্ষরের মধ্যে রাখুন।');
    const safeCandles=Array.isArray(candles)?candles.slice(-80):[];
    const system=`তুমি BM TRADER XY-এর বাংলা market research assistant। সহজ ও পরিষ্কার বাংলায় উত্তর দাও।
শুধু user-provided verified candle data এবং analysis থেকে market-specific সিদ্ধান্ত ব্যাখ্যা করবে।
ডেটা না থাকলে বলবে লাইভ ডেটা পাওয়া যায়নি। অসম্পূর্ণ candle-কে completed বলবে না।
UP/DOWN/WAIT কেবল rule-based evidence হিসেবে ব্যাখ্যা করবে; কখনো নিশ্চিত লাভ, ৯৯% accuracy বা guaranteed signal বলবে না।
প্রয়োজনে WAIT বলবে। News, spread, slippage, broker execution এবং OTC feed mismatch-এর সীমাবদ্ধতা মনে করিয়ে দেবে।
ব্যক্তিগত আর্থিক পরামর্শ বা trade execution করবে না।`;
    const payload={ question:message, market:market||'unknown', timeframe:timeframe||'unknown',
      latestCandles:safeCandles, technicalSummary:analysis||null };
    const upstream=await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST', signal:AbortSignal.timeout(25_000),
      headers:{ Authorization:`Bearer ${OPENAI_KEY}`, 'Content-Type':'application/json' },
      body:JSON.stringify({ model:OPENAI_MODEL, temperature:0.2,
        messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(payload)}] })
    });
    const data=await upstream.json();
    if (!upstream.ok) return fail(res,502,data.error?.message||'AI provider request failed');
    const reply=data.choices?.[0]?.message?.content;
    if (!reply) return fail(res,502,'AI কোনো উত্তর দেয়নি।');
    res.json({ reply, model:OPENAI_MODEL });
  } catch(e) { fail(res,502,e.name==='TimeoutError'?'AI server timeout; আবার চেষ্টা করুন।':e.message); }
});
app.use((err,req,res,next) => {
  if (err.message==='Origin not allowed') return fail(res,403,'এই website origin অনুমোদিত নয়।');
  console.error('Backend error:', err.message);
  return fail(res,500,'Backend internal error');
});
app.listen(PORT,()=>console.log(`BM TRADER XY backend running on port ${PORT}`));
