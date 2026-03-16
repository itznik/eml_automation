import { ImapFlow } from 'imapflow';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs/promises';
import path from 'path';
import 'dotenv/config';

// Initialize AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Target Languages based on client requirements
const TARGET_LANGUAGES = ['Hebrew', 'Hindi', 'Indonesian', 'Malay', 'Thai'];

// The EXACT categories extracted from "TS Email Categorisation Guidelines"
const MAIN_CATEGORIES = [
    'One-time Passwords',
    'Email Verification',
    'Login & Accounts',
    'Digital Signatures',
    'Calendar Invites',
    'Calendar Updates',
    'Appointment Reminders',
    'Travel Updates',
    'Utility & Service Notices',
    'Lease & Property Notice',
    'Financial Alerts',
    'Hiring Life Cycle Updates',
    'TimeSensitive - Others',
    'Travel Confirmations (Not-Time Sensitive)',
    'Shipments (Not-Time Sensitive)',
    'Transactions (Not-Time Sensitive)',
    'Not-Time Sensitive - Others',
    'Unknown',
    'Other Language'
];

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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function categorizeWithRetry(subject, from, retries = 3) {
    const prompt = `
    Categorize this email based strictly on the provided guidelines.
    Sender: ${from}
    Subject: ${subject}
    
    Rules:
    1. Identify the language. If it is NOT Hebrew, Hindi, Indonesian, Malay, or Thai, the category MUST be "Other Language".
    2. Choose EXACTLY ONE category from the following list. Do not invent categories:
       - One-time Passwords
       - Email Verification
       - Login & Accounts
       - Digital Signatures
       - Calendar Invites
       - Calendar Updates
       - Appointment Reminders
       - Travel Updates
       - Utility & Service Notices
       - Lease & Property Notice
       - Financial Alerts
       - Hiring Life Cycle Updates
       - TimeSensitive - Others
       - Travel Confirmations (Not-Time Sensitive)
       - Shipments (Not-Time Sensitive)
       - Transactions (Not-Time Sensitive)
       - Not-Time Sensitive - Others
       - Unknown
       - Other Language
    3. Return ONLY valid JSON. Do not use markdown.
    
    Format: {"language": "Hindi", "category": "One-time Passwords"}
    `;

    for (let i = 0; i < retries; i++) {
        try {
            const result = await model.generateContent(prompt);
            let text = result.response.text().trim();
            if (text.startsWith('```json')) text = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(text);
        } catch (error) {
            if (i === retries - 1) return { language: "Unknown", category: "Unknown" };
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
    console.log('[IMAP] Connected securely.');

    try {
        let mailbox = await client.mailboxOpen('[Gmail]/All Mail');
        console.log(`[IMAP] Total messages found: ${mailbox.exists}`);

        if (mailbox.exists === 0) {
            console.log('\n[WARNING] No emails found.');
            return;
        }

        console.log('[IMAP] Step 1: Scanning all email headers (Fast Mode)...');
        
        // Step 1: Collect all headers first without doing any other operations
        const allHeaders = [];
        const messages = client.fetch('1:*', { uid: true, envelope: true });
        
        for await (let msg of messages) {
            allHeaders.push({
                uid: msg.uid,
                subject: msg.envelope.subject || 'No Subject',
                from: msg.envelope.from?.[0]?.address || 'Unknown Sender'
            });
        }
        
        console.log(`[IMAP] Step 1 Complete! Found ${allHeaders.length} emails.`);
        console.log(`[IMAP] Step 2: Starting AI categorization and secure downloading...\n`);

        // Step 2: Now that the scan is done, loop through our saved list
        for (const header of allHeaders) {
            console.log(`-----------------------------------`);
            console.log(`[Analyzing] UID: ${header.uid} | From: ${header.from}`);

            // Ask AI based ONLY on headers
            const aiResult = await categorizeWithRetry(header.subject, header.from);
            
            // Safety fallback: Ensure AI didn't hallucinate a category
            let finalCat = MAIN_CATEGORIES.includes(aiResult.category) ? aiResult.category : 'Unknown';
            let finalLang = TARGET_LANGUAGES.includes(aiResult.language) ? aiResult.language : 'Other';

            // Override language category rule based on guidelines
            if (finalLang === 'Other') {
                finalCat = 'Other Language';
            }

            console.log(`[Approved] Language: ${finalLang} | Category: ${finalCat}`);

            const finalDir = path.join(process.cwd(), 'output', finalLang, finalCat);
            await ensureDirectoryExists(finalDir);

            const finalFilePath = path.join(finalDir, `${header.uid}_${Date.now()}.eml`);
            
            // Safe, isolated fetch for just this one email
            const fullMsg = await client.fetchOne(header.uid, { source: true }, { uid: true });
            
            if (fullMsg && fullMsg.source) {
                await fs.writeFile(finalFilePath, fullMsg.source);
                console.log(`[Saved] -> ${finalFilePath}`);
            } else {
                console.log(`[Error] Could not download source for UID: ${header.uid}`);
            }
        }
        
        console.log('\n[SUCCESS] Pipeline complete! All emails have been processed and saved.');

    } catch (err) {
        console.error('\n[System Error Details]:\n', err);
    } finally {
        await client.logout();
        console.log('[IMAP] Connection closed.');
    }
}

processInbox();
