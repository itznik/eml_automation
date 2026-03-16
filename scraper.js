import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import axios from 'axios';
import fs from 'fs/promises';
import 'dotenv/config';

// Initialize Redis connection
const redisConnection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
});

// Create the Scraping Queue
const scrapeQueue = new Queue('scrapeQueue', { connection: redisConnection });

// Helper to save extracted data
async function saveExtractedData(data, sourceUrl) {
    const filename = `data_${Date.now()}.json`;
    await fs.appendFile('scraped_results.json', JSON.stringify({ url: sourceUrl, data }) + '\n');
}

// Worker processes jobs synchronously but handles errors robustly
const worker = new Worker('scrapeQueue', async job => {
    const { url, type } = job.data;
    console.log(`[Scraping] Started job ${job.id}: ${url}`);

    try {
        if (type === 'api' || type === 'static') {
            // Fast Route: Axios + Cheerio
            const response = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                timeout: 10000 
            });

            if (type === 'api') {
                await saveExtractedData(response.data, url);
                console.log(`[Success] Extracted API JSON from ${url}`);
            } else {
                const $ = cheerio.load(response.data);
                // Example Extraction: Grab all text from paragraphs or specific selectors
                const pageText = $('body').text().replace(/\s+/g, ' ').trim();
                await saveExtractedData({ text: pageText.substring(0, 1000) }, url);
                console.log(`[Success] Extracted Static HTML from ${url}`);
            }

        } else if (type === 'dynamic') {
            // Heavy Route: Playwright for SPAs / React sites
            const browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();
            
            // Block images/css to save bandwidth and memory
            await page.route('**/*.(png|jpg|jpeg|gif|css)', route => route.abort());
            
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            
            const content = await page.content();
            const $ = cheerio.load(content);
            const extractedLinks = [];
            $('a').each((i, el) => {
                extractedLinks.push($(el).attr('href'));
            });

            await saveExtractedData({ links: extractedLinks }, url);
            await browser.close();
            console.log(`[Success] Extracted Dynamic Data from ${url}`);
        }

    } catch (error) {
        console.error(`[Job Failed] ${url} - Error: ${error.message}`);
        // Throwing error allows BullMQ to handle retries automatically
        throw error;
    }
}, { 
    connection: redisConnection,
    concurrency: 3 // Restrict memory usage: Run max 3 browsers at once
});

worker.on('completed', job => {
    console.log(`[Queue] Job ${job.id} has completed!`);
});

worker.on('failed', (job, err) => {
    console.log(`[Queue] Job ${job.id} has failed with ${err.message}`);
});

// Example Usage: Seed the queue with target links
async function seedQueue() {
    await scrapeQueue.add('ScrapeTask', { url: '[https://jsonplaceholder.typicode.com/posts/1](https://jsonplaceholder.typicode.com/posts/1)', type: 'api' });
    await scrapeQueue.add('ScrapeTask', { url: '[https://news.ycombinator.com/](https://news.ycombinator.com/)', type: 'static' });
    // Add thousands of links here; BullMQ will manage the memory and execution limits safely.
    console.log('[Queue] Seeding complete. Worker is processing...');
}

// Ensure Redis is running before seeding
redisConnection.on('ready', () => {
    console.log('[Redis] Connected. Starting scraper...');
    seedQueue();
});
