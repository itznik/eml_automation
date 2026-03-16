import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';
import 'dotenv/config';

// Initialize AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// The specific categories you requested
const TARGET_LANGUAGES = ['Hebrew', 'Hindi', 'Indonesian', 'Malay', 'Thai', 'English'];
const MAIN_CATEGORIES = ['OTP', 'Scam', 'News', 'Promotion', 'Transaction', 'Bank', 'Ticket', 'Bookings', 'Unknown'];

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
    You are a strict data categorization AI for an email extraction project.
    Analyze the email metadata and categorize it based strictly on the categories below.
    
    Sender: ${from}
    Subject: ${subject}
    
    Rules:
    1. Identify the language.
    2. Identify the Main Category. You MUST choose exactly ONE of the following:
       - OTP (One-time passwords, verification codes, login alerts)
       - Scam (Phishing, suspicious offers, fake alerts)
       - News (Newsletters, press releases, daily updates)
       - Promotion (Marketing, discounts, sales, offers)
       - Transaction (Order confirmations, receipts, invoices, shipping)
       - Bank (Account statements, balance updates, credit card notices)
       - Ticket (Event tickets, movie tickets, entry passes)
       - Bookings (Flight, hotel, train, or restaurant reservations)
    3. Return ONLY a valid JSON object. Do not include markdown formatting or backticks.
    
    Expected JSON format:
    {
      "language": "English",
      "category": "Promotion"
    }`;

    try {
        const result = await model.generateContent(prompt);
        let text = result.response.text().trim();
        
        // Clean markdown block if AI adds it
        if (text.startsWith('```json')) {
            text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        }
        
        return JSON.parse(text);
    } catch (error) {
        console.error(`[AI Error] Failed to categorize: ${error.message}`);
        return { language: "Unknown", category: "Unknown" };
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
        // Look at All Mail to catch everything
        let mailbox = await client.mailboxOpen('[Gmail]/All Mail');
        console.log(`[IMAP] Mailbox opened. Total messages found: ${mailbox.exists}`);

        if (mailbox.exists === 0) {
            console.log('\n[WARNING] No emails found to process.');
            return;
        }

        console.log('[IMAP] Fetching emails...');

        // Fetch all UIDs and their raw source
        const messages = client.fetch('1:*', { uid: true, source: true });
        
        for await (let msg of messages) {
            const uid = msg.uid;
            console.log(`\n[Processing] Email UID: ${uid}`);

            // The fix: msg.source is a Buffer, not a stream. Write it directly.
            const tempFilePath = path.join(process.cwd(), `temp_${uid}.eml`);
            await fs.writeFile(tempFilePath, msg.source);

            // Parse headers from the saved file
            const emailContent = await fs.readFile(tempFilePath);
            const parsed = await simpleParser(emailContent);
            
            const subject = parsed.subject || 'No Subject';
            const from = parsed.from?.text || 'Unknown Sender';

            console.log(`[Extracted] From: ${from} | Subject: ${subject}`);

            // Ask Gemini for categorization
            const aiResult = await categorizeEmail(subject, from);
            console.log(`[Categorized] ${aiResult.language} -> ${aiResult.category}`);

            // Validate against your requested categories
            let finalCat = MAIN_CATEGORIES.includes(aiResult.category) ? aiResult.category : 'Unknown';
            let finalLang = aiResult.language || 'Unknown';

            // Build final directory structure: ./output/English/Promotion/
            const finalDir = path.join(process.cwd(), 'output', finalLang, finalCat);
            await ensureDirectoryExists(finalDir);

            // Move the file to the categorized folder
            const finalFilePath = path.join(finalDir, `${uid}_${Date.now()}.eml`);
            await fs.rename(tempFilePath, finalFilePath);
            
            console.log(`[Saved] -> ${finalFilePath}`);
        }
        
        console.log('\n[SUCCESS] All emails have been downloaded and categorized!');

    } catch (err) {
        console.error('[System Error]', err);
    } finally {
        await client.logout();
        console.log('[IMAP] Connection closed.');
    }
}

processInbox();
