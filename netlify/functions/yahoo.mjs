import { checkEntitlement } from "../lib/entitlement.mjs";

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 8000;

// Bounds each outbound Yahoo call so one unresponsive request can't burn the whole
// function's execution budget (observed: Yahoo silently hangs some requests under load).
function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Module-scope cache: reused across invocations while the function container stays warm,
// since Yahoo now requires a session cookie + crumb for quoteSummary and the handshake is slow.
let authCache = null;

async function fetchYahooAuth() {
  const cookieRes = await fetchWithTimeout('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const setCookie = typeof cookieRes.headers.getSetCookie === 'function'
    ? cookieRes.headers.getSetCookie()
    : [cookieRes.headers.get('set-cookie')].filter(Boolean);
  if (!setCookie.length) throw new Error('Yahoo auth failed: no cookie received');
  const cookie = setCookie.map(c => c.split(';')[0]).join('; ');

  const crumbRes = await fetchWithTimeout('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, Cookie: cookie }
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumb || crumb.includes('<html')) throw new Error('Yahoo auth failed: no crumb received');

  return { cookie, crumb };
}

async function getYahooAuth(forceRefresh) {
  if (!forceRefresh && authCache) return authCache;
  authCache = await fetchYahooAuth();
  return authCache;
}

export default async (req) => {
  const ent = await checkEntitlement(req);
  if (!ent.ok) {
    return new Response(JSON.stringify({ error: ent.error }), {
      status: ent.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ticker = new URL(req.url).searchParams.get('ticker');
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d`;

  try {
    let auth = await getYahooAuth(false);
    const statsUrl = () => `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics,financialData,summaryDetail,incomeStatementHistory,cashflowStatementHistory,balanceSheetHistory&crumb=${encodeURIComponent(auth.crumb)}`;

    let [chartRes, statsRes] = await Promise.all([
      fetchWithTimeout(chartUrl, { headers: { 'User-Agent': UA } }),
      fetchWithTimeout(statsUrl(), { headers: { 'User-Agent': UA, Cookie: auth.cookie } })
    ]);
    let chart = await chartRes.json();
    let stats = await statsRes.json();

    if (!stats.quoteSummary?.result) {
      // Crumb may have expired: refresh once and retry the stats call.
      auth = await getYahooAuth(true);
      statsRes = await fetchWithTimeout(statsUrl(), { headers: { 'User-Agent': UA, Cookie: auth.cookie } });
      stats = await statsRes.json();
    }

    const result = chart.chart.result[0];
    const q = stats.quoteSummary.result[0];
    const quote = result.indicators.quote[0];

    return new Response(JSON.stringify({
      name: ticker,
      price: result.meta.regularMarketPrice,
      pe: q.summaryDetail?.trailingPE?.raw ?? null,
      pb: q.defaultKeyStatistics?.priceToBook?.raw ?? null,
      roe5yr: q.financialData?.returnOnEquity?.raw != null ? q.financialData.returnOnEquity.raw * 100 : null,
      roic: q.financialData?.returnOnAssets?.raw != null ? q.financialData.returnOnAssets.raw * 100 : null,
      debtToEquity: q.financialData?.debtToEquity?.raw != null ? q.financialData.debtToEquity.raw / 100 : null,
      earningsGrowth5yr: q.financialData?.earningsGrowth?.raw != null ? q.financialData.earningsGrowth.raw * 100 : null,
      fcf: q.financialData?.freeCashflow?.raw ?? null,
      shares: q.defaultKeyStatistics?.sharesOutstanding?.raw ?? null,
      netDebt: q.financialData?.totalDebt?.raw ?? null,
      closes: quote.close,
      highs: quote.high,
      lows: quote.low,
      volumes: quote.volume,
      timestamps: result.timestamp
    }), {
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.toString() }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
