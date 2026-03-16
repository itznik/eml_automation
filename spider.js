import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { URL } from 'url';

// --- Configuration ---
// Add 3-5 large websites here to start the hunt
const SEED_URLS = [
    'https://en.wikipedia.org/wiki/Main_Page',
    'https://news.ycombinator.com/',
    'https://dev.to/'
];

const TARGET_LINK_COUNT = 50000;
const CONCURRENCY_LIMIT = 5; // How many pages to scan at the exact same time
const OUTPUT_FILE = 'targets.txt';

// State management
const visitedUrls = new Set();
const urlQueue = [...SEED_URLS];
let totalLinksFound = 0;
let activeRequests = 0;

// Helper: Normalize URLs to prevent duplicates (e.g., remove #fragments)
function normalizeUrl(baseUrl, href) {
    try {
        const urlObj = new URL(href, baseUrl);
        // Ignore mailto, javascript, tel, etc.
        if (!['http:', 'https:'].includes(urlObj.protocol)) return null;
        // Remove hash fragments
        urlObj.hash = '';
        return urlObj.href;
    } catch (err) {
        return null; // Invalid URL
    }
}

async function crawl() {
    // Open a stream to append links efficiently without eating up RAM
    const stream = createWriteStream(OUTPUT_FILE, { flags: 'a' });

    console.log(`[Spider] Starting crawl. Target: ${TARGET_LINK_COUNT} links.`);

    return new Promise((resolve) => {
        const processNext = async () => {
            // Stop if we hit our target or run out of links
            if (totalLinksFound >= TARGET_LINK_COUNT || (urlQueue.length === 0 && activeRequests === 0)) {
                stream.end();
                resolve();
                return;
            }

            // Keep firing requests up to our concurrency limit
            while (activeRequests < CONCURRENCY_LIMIT && urlQueue.length > 0 && totalLinksFound < TARGET_LINK_COUNT) {
                const currentUrl = urlQueue.shift();

                if (visitedUrls.has(currentUrl)) continue;
                visitedUrls.add(currentUrl);
                activeRequests++;

                console.log(`[Spider] Scanning (${totalLinksFound}/${TARGET_LINK_COUNT}): ${currentUrl}`);

                // Fire the request without awaiting here to allow parallel execution
                fetchAndExtract(currentUrl, stream).finally(() => {
                    activeRequests--;
                    processNext(); // Trigger the next batch when one finishes
                });
            }
        };

        processNext();
    });
}

async function fetchAndExtract(targetUrl, stream) {
    try {
        const response = await axios.get(targetUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'
            },
            timeout: 10000 // Skip pages that take too long
        });

        // Only parse HTML pages
        const contentType = response.headers['content-type'] || '';
        if (!contentType.includes('text/html')) return;

        const $ = cheerio.load(response.data);
        const newLinks = [];

        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (!href) return;

            const absoluteUrl = normalizeUrl(targetUrl, href);
            
            // If valid, not seen before, and not already in queue
            if (absoluteUrl && !visitedUrls.has(absoluteUrl) && !newLinks.includes(absoluteUrl)) {
                newLinks.push(absoluteUrl);
            }
        });

        // Save new links and add them to the queue
        for (const link of newLinks) {
            if (totalLinksFound >= TARGET_LINK_COUNT) break;
            
            // Defaulting the type to 'static' for the scraper later
            const formattedLine = `${link},static\n`;
            
            stream.write(formattedLine);
            urlQueue.push(link);
            totalLinksFound++;
        }

    } catch (error) {
        // Silently ignore 404s, timeouts, etc., and move on
        // console.error(`[Spider] Failed to scan ${targetUrl}: ${error.message}`);
    }
}

// Start the spider
crawl().then(() => {
    console.log(`\n[Spider] Crawl complete! Saved ${totalLinksFound} links to ${OUTPUT_FILE}.`);
    console.log(`[Spider] You can now run your main scraper queue.`);
    process.exit(0);
});
