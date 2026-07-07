exports.handler = async (event) => {
  const { ticker } = event.queryStringParameters;
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d`;
  const statsUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics,financialData,incomeStatementHistory,cashflowStatementHistory,balanceSheetHistory`;

  try {
    const [chartRes, statsRes] = await Promise.all([fetch(chartUrl), fetch(statsUrl)]);
    const chart = await chartRes.json();
    const stats = await statsRes.json();
    const result = chart.chart.result[0];
    const q = stats.quoteSummary.result[0];
    const quote = result.indicators.quote[0];

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      body: JSON.stringify({
        name: ticker,
        price: result.meta.regularMarketPrice,
        pe: q.defaultKeyStatistics?.trailingPE?.raw || null,
        pb: q.defaultKeyStatistics?.priceToBook?.raw || null,
        roe5yr: q.financialData?.returnOnEquity?.raw * 100 || null,
        roic: q.financialData?.returnOnAssets?.raw * 100 || null,
        debtToEquity: q.financialData?.debtToEquity?.raw / 100 || null,
        earningsGrowth5yr: q.defaultKeyStatistics?.earningsGrowth?.raw * 100 || null,
        fcf: q.financialData?.freeCashflow?.raw || null,
        shares: q.defaultKeyStatistics?.sharesOutstanding?.raw || null,
        netDebt: q.financialData?.totalDebt?.raw || null,
        closes: quote.close,
        highs: quote.high,
        lows: quote.low,
        volumes: quote.volume,
        timestamps: result.timestamp
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.toString() }) };
  }
};