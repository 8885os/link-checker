// link-check.mjs
// On-demand broken-link checker for multiple sites.
// Crawls each site's internal HTML pages, collects every link, checks each
// one's status, and prints a report split into real breaks vs blocked/unchecked.
//
// Setup (once):  npm install
// Run:           node link-check.mjs
// Requires Node 18+ (uses global fetch and AbortSignal.timeout).

import { CheerioCrawler, RequestQueue } from 'crawlee';

// ---- Client sites -------------------------------------------------------
const SITES = [
  'https://www.wdc-brands.com',
  'https://www.wdc-spaces.com',
  'https://b2pm.co.uk',
  'https://www.cclsolutionsgroup.com',
  'https://heligangroup.com',
  'https://www.jpalmerarchitects.com',
  'https://www.groupmpc.com',
  'https://www.hyperianlaw.com',
  'https://www.renaissance-advisory.london',
];
// -------------------------------------------------------------------------

const MAX_PAGES = 300;          // safety cap on pages crawled per site
const REQUEST_TIMEOUT = 20000;  // ms, per link status check
const CHECK_CONCURRENCY = 10;   // parallel link checks
const MAX_CONCURRENCY = 5;      // parallel page crawls (gentle on client sites)
const MAX_SOURCES_SHOWN = 3;    // cap "found on" pages per broken link

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Files we should status-check but never try to parse as HTML pages.
const ASSET_RE =
  /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|jpe?g|png|gif|webp|svg|mp4|mov|avi|mp3|wav|woff2?|ttf|eot|ico|css|js)(\?|#|$)/i;

// Status codes that mean "the server refused a bot", not "the page is missing".
// Treated as blocked/uncheckable rather than broken.
const BLOCK_STATUSES = new Set([401, 403, 406, 429, 451, 999]);

function normalise(href, base) {
  try {
    const u = new URL(href, base);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function host(u) {
  return new URL(u).hostname.replace(/^www\./, '');
}

function sameSite(url, base) {
  try {
    return host(url) === host(base);
  } catch {
    return false;
  }
}

async function checkUrl(url) {
  const opts = {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    headers: { 'user-agent': BROWSER_UA },
  };
  try {
    let res = await fetch(url, { ...opts, method: 'HEAD' });
    if ([403, 405, 501].includes(res.status)) {
      res = await fetch(url, { ...opts, method: 'GET' });
    }
    return { status: res.status, ok: res.status < 400 };
  } catch (e) {
    return { status: e.name === 'TimeoutError' ? 'timeout' : 'error', ok: false };
  }
}

async function checkAll(urls) {
  const list = [...urls];
  const results = new Map();
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const url = list[i++];
      results.set(url, await checkUrl(url));
    }
  }
  await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker));
  return results;
}

// Decide what a failed check means.
// 'broken'  -> a real problem worth fixing (404/410/5xx, or internal timeout/error)
// 'blocked' -> server refused the bot, or an external link we can't verify
function classify(res, internal) {
  if (res.ok) return 'ok';
  if (typeof res.status === 'number' && BLOCK_STATUSES.has(res.status)) return 'blocked';
  if (res.status === 'timeout' || res.status === 'error') return internal ? 'broken' : 'blocked';
  return 'broken';
}

async function crawlSite(site, idx) {
  const links = new Map(); // url -> Set(source pages)

  const queue = await RequestQueue.open(`q-${Date.now()}-${idx}`);
  await queue.addRequest({ url: site });

  const crawler = new CheerioCrawler({
    requestQueue: queue,
    maxRequestsPerCrawl: MAX_PAGES,
    maxConcurrency: MAX_CONCURRENCY,
    requestHandlerTimeoutSecs: 60,
    maxRequestRetries: 1,
    sessionPoolOptions: { blockedStatusCodes: [] },
    preNavigationHooks: [
      (_ctx, gotOptions) => {
        gotOptions.headers = {
          ...gotOptions.headers,
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-GB,en;q=0.9',
        };
      },
    ],
    async requestHandler({ request, $, enqueueLinks }) {
      const from = request.url;
      $('a[href]').each((_, el) => {
        const abs = normalise($(el).attr('href'), from);
        if (!abs) return;
        if (!links.has(abs)) links.set(abs, new Set());
        links.get(abs).add(from);
      });
      // Crawl onward only into HTML pages on this site; never into PDFs/assets.
      await enqueueLinks({ strategy: 'same-domain', exclude: [ASSET_RE] });
    },
    failedRequestHandler({ request }) {
      if (!links.has(request.url)) links.set(request.url, new Set(['(crawl)']));
    },
  });

  await crawler.run();
  return links;
}

function printSources(sources) {
  const arr = [...sources];
  for (const s of arr.slice(0, MAX_SOURCES_SHOWN)) console.log(`        on: ${s}`);
  const extra = arr.length - MAX_SOURCES_SHOWN;
  if (extra > 0) console.log(`        ...and ${extra} more page(s)`);
}

async function main() {
  if (SITES.length === 0) {
    console.error('No sites configured. Edit the SITES array at the top of link-check.mjs.');
    process.exit(1);
  }

  for (let idx = 0; idx < SITES.length; idx++) {
    const site = SITES[idx];
    console.log(`\n=== ${site} ===`);

    const links = await crawlSite(site, idx);
    const statuses = await checkAll(links.keys());

    const broken = [];
    const blocked = [];
    for (const [url, res] of statuses) {
      const internal = sameSite(url, site);
      const verdict = classify(res, internal);
      if (verdict === 'broken') {
        broken.push({ url, status: res.status, internal, sources: links.get(url) });
      } else if (verdict === 'blocked') {
        blocked.push({ url, status: res.status });
      }
    }

    broken.sort((a, b) => Number(b.internal) - Number(a.internal));

    if (broken.length === 0) {
      console.log(`  No broken links to fix (${links.size} links checked).`);
    } else {
      console.log(`  ${broken.length} link(s) to fix:`);
      for (const b of broken) {
        console.log(`  [${b.status}] ${b.internal ? 'internal' : 'external'}  ${b.url}`);
        printSources(b.sources);
      }
    }

    if (blocked.length > 0) {
      console.log(`  ${blocked.length} link(s) blocked or not checkable (bot protection / external — likely fine, not listed in detail).`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
