import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import 'dotenv/config';

// Initialize AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Target parameters from guidelines
const TARGET_LANGUAGES = ['Hebrew', 'Hindi', 'Indonesian', 'Malay', 'Thai'];
const MAIN_CATEGORIES = ['High Impact', 'Transactions', 'News', 'Social', 'Promotional', 'Unknown'];

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

async function categorizeEmail(subject, from) {
    const prompt = `
    You are a strict data categorization AI for a machine learning training project.
    Analyze the email metadata and categorize it based on the strict guidelines below.
    
    Sender: ${from}
    Subject: ${subject}
    
    Rules:
    1. Identify the language. Must be one of: Hebrew, Hindi, Indonesian, Malay, Thai. If none, output "Other".
    2. Identify the Main Category:
       - High Impact: (Time-sensitive, OTPs, login verification, security, utility notices, travel updates)
       - Transactions: (Order confirmations, receipts, invoices, shipping updates, bank statements)
       - News: (Newsletters, press releases)
       - Social: (Friend requests, social media mentions)
       - Promotional: (Marketing, discounts, offers, "act fast" sales)
    3. Return ONLY a valid JSON object. Do not include markdown formatting or backticks.
    
    Expected JSON format:
    {
      "language": "Hindi",
      "category": "Promotional",
      "subCategory": "Discounts"
    }`;

    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text().trim();
        // Clean markdown block if AI adds it
        if (text.startsWith('```json')) text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        
        return JSON.parse(text);
    } catch (error) {
        console.error(`[AI Error] Failed to categorize: ${error.message}`);
        return { language: "Unknown", category: "Unknown", subCategory: "Unknown" };
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

    // FIX: Using mailboxOpen instead of getMailboxLock
    await client.mailboxOpen('INBOX');
    try {
        // Fetch all UIDs to process
        const messages = client.fetch('1:*', { uid: true, source: true });
        
        for await (let msg of messages) {
            const uid = msg.uid;
            console.log(`\n[Processing] Email UID: ${uid}`);

            // Memory Management: Save raw source stream directly to a temporary file
            const tempFilePath = path.join(process.cwd(), `temp_${uid}.eml`);
            const writeStream = createWriteStream(tempFilePath);
            
            await new Promise((resolve, reject) => {
                msg.source.pipe(writeStream);
                msg.source.on('end', resolve);
                msg.source.on('error', reject);
            });

            // Parse headers from the saved file to save RAM
            const emailContent = await fs.readFile(tempFilePath);
            const parsed = await simpleParser(emailContent);
            
            const subject = parsed.subject || 'No Subject';
            const from = parsed.from?.text || 'Unknown Sender';

            console.log(`[Extracted] From: ${from} | Subject: ${subject}`);

            // Ask Gemini for categorization
            const aiResult = await categorizeEmail(subject, from);
            console.log(`[Categorized] ${aiResult.language} -> ${aiResult.category}`);

            // Validate against client requirements
            let finalLang = TARGET_LANGUAGES.includes(aiResult.language) ? aiResult.language : 'Other';
            let finalCat = MAIN_CATEGORIES.includes(aiResult.category) ? aiResult.category : 'Unknown';

            // Build final directory structure: ./output/Hindi/Promotional/
            const finalDir = path.join(process.cwd(), 'output', finalLang, finalCat);
            await ensureDirectoryExists(finalDir);

            // Move the temp file to the categorized folder
            const finalFilePath = path.join(finalDir, `${uid}_${Date.now()}.eml`);
            await fs.rename(tempFilePath, finalFilePath);
            
            console.log(`[Saved] -> ${finalFilePath}`);
        }
    } catch (err) {
        console.error('[System Error]', err);
    } finally {
        // FIX: Removed lock.release(), ImapFlow handles closing the mailbox natively on logout
        await client.logout();
        console.log('[IMAP] Connection closed.');
    }
}

processInbox();
