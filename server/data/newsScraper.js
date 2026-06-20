const Parser = require('rss-parser');
const logger = require('../utils/logger');

const parser = new Parser({ timeout: 8000, maxRedirects: 3 });

// ─── Feed Registry ────────────────────────────────────────────────────────────
// All feeds verified working as of May 2026. Reuters removed (DNS unreachable).
const FEEDS = [
  // General financial news
  { name: 'Yahoo Finance',    url: 'https://finance.yahoo.com/news/rssindex',                tags: ['general'] },
  { name: 'MarketWatch',      url: 'https://feeds.marketwatch.com/marketwatch/topstories',  tags: ['general'] },
  { name: 'Seeking Alpha',    url: 'https://seekingalpha.com/market_currents.xml',           tags: ['general'] },
  { name: 'Benzinga',         url: 'https://www.benzinga.com/feed',                          tags: ['general'] },
  { name: 'Investing.com',    url: 'https://www.investing.com/rss/news.rss',                 tags: ['general'] },
  // Crypto-specific news
  { name: 'CoinTelegraph',    url: 'https://cointelegraph.com/rss',                          tags: ['crypto'] },
  { name: 'CoinDesk',         url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',        tags: ['crypto'] },
  { name: 'Decrypt',          url: 'https://decrypt.co/feed',                                tags: ['crypto'] },
  { name: 'CryptoSlate',      url: 'https://cryptoslate.com/feed/',                          tags: ['crypto'] },
];

// ─── Feed caching ─────────────────────────────────────────────────────────────
// Cache feeds for 5 minutes to avoid hammering sources on every 1-min bar
const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = {}; // { feedUrl: { items, fetchedAt } }

async function fetchFeed(feed) {
  const now = Date.now();
  if (_cache[feed.url] && (now - _cache[feed.url].fetchedAt) < CACHE_TTL_MS) {
    return _cache[feed.url].items;
  }

  try {
    const data = await Promise.race([
      parser.parseURL(feed.url),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after 8s`)), 8000)),
    ]);
    const items = (data.items || []).slice(0, 20).map(item => ({
      source:   feed.name,
      title:    item.title || '',
      summary:  (item.contentSnippet || item.content || '').slice(0, 300),
      link:     item.link  || '',
      date:     item.isoDate || item.pubDate || new Date().toISOString(),
    }));
    _cache[feed.url] = { items, fetchedAt: now };
    return items;
  } catch (err) {
    // Only log if it's a new failure (not same error repeated every minute)
    const cacheEntry = _cache[feed.url];
    const lastErrTime = cacheEntry?._lastErrAt || 0;
    if (now - lastErrTime > 10 * 60 * 1000) { // max once per 10 min
      logger.warn(`RSS feed unavailable: ${feed.name}`, { error: err.message });
      if (!_cache[feed.url]) _cache[feed.url] = { items: [] };
      _cache[feed.url]._lastErrAt = now;
    }
    return _cache[feed.url]?.items || [];
  }
}

// ─── Symbol → Search Terms ───────────────────────────────────────────────────

function getSearchTerms(symbol) {
  const base = symbol.split(/[-/]/)[0].toLowerCase();
  const terms = [base];

  const aliases = {
    // Crypto
    btc:  ['bitcoin', 'btc'],
    eth:  ['ethereum', 'ether', 'eth'],
    sol:  ['solana', 'sol'],
    ada:  ['cardano', 'ada'],
    doge: ['dogecoin', 'doge'],
    avax: ['avalanche', 'avax'],
    dot:  ['polkadot', 'dot'],
    link: ['chainlink', 'link'],
    ltc:  ['litecoin', 'ltc'],
    bnb:  ['binance', 'bnb'],
    xrp:  ['ripple', 'xrp'],
    // Equities
    aapl: ['apple'],
    tsla: ['tesla'],
    nvda: ['nvidia'],
    msft: ['microsoft'],
    amzn: ['amazon'],
    googl: ['google', 'alphabet'],
    meta: ['meta', 'facebook'],
    spy:  ['s&p', 'spx', 'spy'],
    qqq:  ['nasdaq', 'qqq'],
  };

  if (aliases[base]) {
    return [...new Set([base, ...aliases[base]])];
  }
  return terms;
}

function isRelevant(item, terms) {
  const text = (item.title + ' ' + item.summary).toLowerCase();
  return terms.some(t => text.includes(t));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scrape all feeds and return articles relevant to a symbol.
 * For crypto symbols, crypto feeds are weighted first.
 */
async function scrapeForSymbol(symbol, limit = 8) {
  const isCrypto = /\/(usd|usdt|usdc)$/i.test(symbol) ||
    ['btc','eth','sol','ada','doge','avax','dot','link','ltc','bnb','xrp']
      .includes(symbol.split(/[-/]/)[0].toLowerCase());

  // For crypto, prioritize crypto feeds but also include general
  const feedsToUse = isCrypto
    ? [...FEEDS.filter(f => f.tags.includes('crypto')), ...FEEDS.filter(f => f.tags.includes('general'))]
    : FEEDS;

  const allItems  = (await Promise.all(feedsToUse.map(fetchFeed))).flat();
  const terms     = getSearchTerms(symbol);
  const relevant  = allItems
    .filter(item => isRelevant(item, terms))
    .sort((a, b)  => new Date(b.date) - new Date(a.date))
    .slice(0, limit);

  logger.info('News scraped', { symbol, total: allItems.length, relevant: relevant.length });
  return relevant;
}

async function scrapeMarketNews(limit = 10) {
  const allItems = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  return allItems
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, limit);
}

module.exports = { scrapeForSymbol, scrapeMarketNews };
