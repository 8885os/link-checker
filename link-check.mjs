// link-check.mjs
// On-demand broken-link checker for multiple sites.
// Crawls each site's internal pages, collects every link, checks each one's
// status, and prints broken links grouped by site.
//
// Setup (once):
//   npm install
//
// Run:
//   node link-check.mjs
//
// Requires Node 18+ (uses global fetch and AbortSignal.timeout).

import { CheerioCrawler, RequestQueue } from 'crawlee'

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
]
// -------------------------------------------------------------------------

const MAX_PAGES = 300 // safety cap on pages crawled per site
const REQUEST_TIMEOUT = 10000 // ms, per link status check
const CHECK_CONCURRENCY = 10 // parallel link checks

// Present as a real browser so WAF/bot protection lets the crawl through.
const BROWSER_UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function normalise(href, base) {
	try {
		const u = new URL(href, base)
		if (!['http:', 'https:'].includes(u.protocol)) return null // skip mailto/tel/etc
		u.hash = ''
		return u.toString()
	} catch {
		return null
	}
}

function host(u) {
	return new URL(u).hostname.replace(/^www\./, '')
}

function sameSite(url, base) {
	try {
		return host(url) === host(base)
	} catch {
		return false
	}
}

async function checkUrl(url) {
	const opts = {
		redirect: 'follow',
		signal: AbortSignal.timeout(REQUEST_TIMEOUT),
		headers: { 'user-agent': BROWSER_UA },
	}
	try {
		let res = await fetch(url, { ...opts, method: 'HEAD' })
		// Some servers reject HEAD; retry with GET before trusting the status.
		if ([403, 405, 501].includes(res.status)) {
			res = await fetch(url, { ...opts, method: 'GET' })
		}
		return { status: res.status, broken: res.status >= 400 }
	} catch (e) {
		return {
			status: e.name === 'TimeoutError' ? 'timeout' : 'error',
			broken: true,
		}
	}
}

async function checkAll(urls) {
	const list = [...urls]
	const results = new Map()
	let i = 0
	async function worker() {
		while (i < list.length) {
			const url = list[i++]
			results.set(url, await checkUrl(url))
		}
	}
	await Promise.all(Array.from({ length: CHECK_CONCURRENCY }, worker))
	return results
}

async function crawlSite(site, idx) {
	const links = new Map() // url -> Set(source pages)

	// Unique queue per site so runs stay isolated within one process.
	const queue = await RequestQueue.open(`q-${Date.now()}-${idx}`)
	await queue.addRequest({ url: site })

	const crawler = new CheerioCrawler({
		requestQueue: queue,
		maxRequestsPerCrawl: MAX_PAGES,
		requestHandlerTimeoutSecs: 30,
		maxRequestRetries: 1,
		// Don't treat 401/403/429 as "blocked" and bail; just record the status.
		sessionPoolOptions: { blockedStatusCodes: [] },
		// Send a real browser UA + headers on the page crawl, not just link checks.
		preNavigationHooks: [
			(_ctx, gotOptions) => {
				gotOptions.headers = {
					...gotOptions.headers,
					'User-Agent': BROWSER_UA,
					Accept:
						'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'Accept-Language': 'en-GB,en;q=0.9',
				}
			},
		],
		async requestHandler({ request, $, enqueueLinks }) {
			const from = request.url
			$('a[href]').each((_, el) => {
				const abs = normalise($(el).attr('href'), from)
				if (!abs) return
				if (!links.has(abs)) links.set(abs, new Set())
				links.get(abs).add(from)
			})
			await enqueueLinks({ strategy: 'same-domain' })
		},
		failedRequestHandler({ request }) {
			// A page that failed to load is itself a broken internal URL.
			if (!links.has(request.url)) links.set(request.url, new Set(['(crawl)']))
		},
	})

	await crawler.run()
	return links
}

async function main() {
	if (SITES.length === 0) {
		console.error(
			'No sites configured. Edit the SITES array at the top of link-check.mjs.',
		)
		process.exit(1)
	}

	for (let idx = 0; idx < SITES.length; idx++) {
		const site = SITES[idx]
		console.log(`\nChecking ${site} ...`)

		const links = await crawlSite(site, idx)
		const statuses = await checkAll(links.keys())

		const broken = []
		for (const [url, res] of statuses) {
			if (res.broken) {
				broken.push({
					url,
					status: res.status,
					internal: sameSite(url, site),
					sources: [...links.get(url)],
				})
			}
		}

		if (broken.length === 0) {
			console.log(`  No broken links found (${links.size} links checked).`)
			continue
		}

		// Internal first, then external.
		broken.sort((a, b) => Number(b.internal) - Number(a.internal))

		console.log(`  ${broken.length} broken link(s) found:`)
		for (const b of broken) {
			console.log(
				`  [${b.status}] ${b.internal ? 'internal' : 'external'}  ${b.url}`,
			)
			for (const s of b.sources) console.log(`        on: ${s}`)
		}
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
