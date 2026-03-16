import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';
import 'dotenv/config';

// Initialize AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// The highly targeted categories
const TARGET_LANGUAGES = ['Hebrew', 'Hindi', 'Indonesian', 'Malay', 'Thai', 'English'];
const MAIN_CATEGORIES = ['OTP', 'Shopping', 'Subscribe', 'Subscriptions', 'Jobs', 'Interview', 'Verification', 'Purchase', 'Booking'];

const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: parseInt(process.env.IMAP_PORT, 10),
    secure: true,
    auth: {
        user: process.env.IMAP_USER,
        pass: process.env.IMAP_PASS
    },
    logger: false 
});

// Helper for pausing execution to prevent API rate limits
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Core AI Categorization
async function categorizeEmail(subject, from) {
    const prompt = `
    You are a strict data categorization AI for a high-value email extraction project.
    Analyze the email metadata and categorize it based strictly on the categories below.
    
    Sender: ${from}
    Subject: ${subject}
    
    Rules:
    1. Identify the language.
    2. Identify the Main Category. You MUST choose exactly ONE of the following:
       - OTP (Verification codes, one-time passwords, login alerts, security codes)
       - Shopping (Order confirmations, receipts, invoices, delivery tracking, e-commerce)
       - Subscribe (Initial newsletter signups, welcome emails, "verify your subscription")
       - Subscriptions (Recurring billing, SaaS renewals, platform monthly subscriptions)
       - Jobs (Application updates, job alerts, recruiter outreach, resume views)
       - Interview (Interview invitations, scheduling links, assessment tasks)
       - Ignore (If the email does not clearly fit into any of the high-value categories above)
    3. Return ONLY a valid JSON object. Do not include markdown formatting or backticks.
    
    Expected JSON format:
    {
      "language": "English",
      "category": "Shopping"
    }`;

    const result = await model.generateContent(prompt);
    let text = result.response.text().trim();
    
    // Clean markdown block if AI adds it
    if (text.startsWith('```json')) {
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    }
    
    return JSON.parse(text);
}

// Bulletproof wrapper for the AI to handle rate limits/network drops safely
async function categorizeWithRetry(subject, from, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await categorizeEmail(subject, from);
        } catch (error) {
            console.log(`[AI Warning] Attempt ${i + 1} failed: ${error.message}`);
            if (i === retries - 1) {
                console.log(`[AI Error] Max retries reached for subject: "${subject}". Defaulting to Ignore.`);
                return { language: "Unknown", category: "Ignore" };
            }
            // Exponential backoff: waits 2s, then 4s, etc., before trying again
            await delay(2000 * (i + 1)); 
        }
    }
}

async function ensureDirectoryExists(dirPath) {
    try {
        await fs.access(dirPath);
    } catch {
        await fs.mkdir(dirPath, { recursive: true });
    }
}

async function processInbox() {
    await client.connect();
    console.log('[IMAP] Connected securely to email server.');

    try {
        let mailbox = await client.mailboxOpen('[Gmail]/All Mail');
        console.log(`[IMAP] Mailbox opened. Total messages found: ${mailbox.exists}`);

        if (mailbox.exists === 0) {
            console.log('\n[WARNING] No emails found to process.');
            return;
        }

        console.log('[IMAP] Fetching emails...');

        const messages = client.fetch('1:*', { uid: true, source: true });
        
        for await (let msg of messages) {
            const uid = msg.uid;
            console.log(`\n-----------------------------------`);
            console.log(`[Processing] Email UID: ${uid}`);

            // Write raw Buffer directly to avoid pipe stream crashes
            const tempFilePath = path.join(process.cwd(), `temp_${uid}.eml`);
            await fs.writeFile(tempFilePath, msg.source);

            // Parse headers
            const emailContent = await fs.readFile(tempFilePath);
            const parsed = await simpleParser(emailContent);
            
            const subject = parsed.subject || 'No Subject';
            const from = parsed.from?.text || 'Unknown Sender';

            console.log(`[Extracted] From: ${from} | Subject: ${subject}`);

            // Call the bulletproof AI function
            const aiResult = await categorizeWithRetry(subject, from);
            console.log(`[Categorized] ${aiResult.language} -> ${aiResult.category}`);

            // Strict Filtering Logic
            let finalCat = MAIN_CATEGORIES.includes(aiResult.category) ? aiResult.category : 'Ignore';

            if (finalCat === 'Ignore') {
                console.log(`[Skipped] Unwanted category. Deleting temp file.`);
                await fs.unlink(tempFilePath); // Free up space immediately
                continue; // Move to the next email
            }

            let finalLang = aiResult.language || 'Unknown';

            // Save only the high-value targets
            const finalDir = path.join(process.cwd(), 'output', finalLang, finalCat);
            await ensureDirectoryExists(finalDir);

            const finalFilePath = path.join(finalDir, `${uid}_${Date.now()}.eml`);
            await fs.rename(tempFilePath, finalFilePath);
            
            console.log(`[Saved] -> ${finalFilePath}`);
        }
        
        console.log('\n[SUCCESS] High-value email extraction complete!');

    } catch (err) {
        console.error('[System Error]', err);
    } finally {
        await client.logout();
        console.log('[IMAP] Connection closed.');
    }
}

processInbox();
