import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import axios from 'axios';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import readline from 'readline';
import 'dotenv/config';

// Initialize Redis connection
const redisConnection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
});

// Create the Scraping Queue
const scrapeQueue = new Queue('scrapeQueue', { 
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true, // Keep Redis memory clean
        removeOnFail: false
    }
});

// Helper to save extracted data
async function saveExtractedData(data, sourceUrl) {
    const filename = `data_${Date.now()}.json`;
    try {
        await fs.appendFile('scraped_results.json', JSON.stringify({ url: sourceUrl, data }) + '\n');
    } catch (err) {
        console.error(`[Storage Error] Failed to write data for ${sourceUrl}:`, err);
    }
}

// Memory-efficient link feeder
async function feedQueueFromFile(filePath) {
    console.log(`[Queue] Reading targets from ${filePath}...`);
    
    const fileStream = createReadStream(filePath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let count = 0;
    for await (const line of rl) {
        if (!line.trim()) continue;
        
        // Split line by comma if format is "URL,type"
        const [url, typeStr] = line.split(',');
        const type = typeStr ? typeStr.trim() : 'static'; // Default to static if not specified
        
        await scrapeQueue.add('ScrapeTask', { url: url.trim(), type });
        count++;
        
        if (count % 1000 === 0) {
            console.log(`[Queue] Added ${count} jobs to the queue...`);
        }
    }
    console.log(`[Queue] Finished seeding ${count} total links into Redis.`);
}

// Worker processes jobs synchronously but handles errors robustly
const worker = new Worker('scrapeQueue', async job => {
    const { url, type } = job.data;
    console.log(`[Scraping] Started job ${job.id}: ${url} (${type})`);

    try {
        if (type === 'api' || type === 'static') {
            const response = await axios.get(url, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
                },
                timeout: 15000 
            });

            if (type === 'api') {
                await saveExtractedData(response.data, url);
                console.log(`[Success] Extracted API JSON from ${url}`);
            } else {
                const $ = cheerio.load(response.data);
                const pageText = $('body').text().replace(/\s+/g, ' ').trim();
                await saveExtractedData({ text: pageText.substring(0, 1000) }, url);
                console.log(`[Success] Extracted Static HTML from ${url}`);
            }

        } else if (type === 'dynamic') {
            const browser = await chromium.launch({ headless: true });
            const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36'
            });
            const page = await context.newPage();
            
            // Block images/css to save bandwidth and memory
            await page.route('**/*.(png|jpg|jpeg|gif|css|svg|woff2)', route => route.abort());
            
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
            
            const content = await page.content();
            const $ = cheerio.load(content);
            const extractedLinks = [];
            
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                if (href && href.startsWith('http')) extractedLinks.push(href);
            });

            await saveExtractedData({ links: extractedLinks }, url);
            await browser.close();
            console.log(`[Success] Extracted Dynamic Data from ${url}`);
        }

    } catch (error) {
        console.error(`[Job Failed] ${url} - Error: ${error.message}`);
        // Throwing error triggers BullMQ automatic retry mechanism
        throw error;
    }
}, { 
    connection: redisConnection,
    concurrency: 5 // Process 5 links simultaneously. Adjust based on cloud container RAM.
});

// Event Listeners for logging
worker.on('completed', job => {
    console.log(`[Queue] Job ${job.id} completed successfully.`);
});

worker.on('failed', (job, err) => {
    console.log(`[Queue] Job ${job.id} failed after attempts: ${err.message}`);
});

// Start the pipeline once Redis connects
redisConnection.on('ready', async () => {
    console.log('[Redis] Connected. Checking for targets.txt...');
    try {
        await fs.access('targets.txt');
        await feedQueueFromFile('targets.txt');
    } catch (err) {
        console.log('[System] targets.txt not found. Worker is running and waiting for jobs...');
    }
});
