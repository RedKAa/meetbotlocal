// meet-recorder-dom-audio.js
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// ====== Config ======
const OUTPUT_DIR = path.join(__dirname, 'recordings');
const RECORD_SECONDS_DEFAULT = 30;
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ====== Stealth ======
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('iframe.contentWindow');
stealth.enabledEvasions.delete('media.codecs');
chromium.use(stealth);

// ====== Helpers ======
const log = (...args) => console.log('[meet]', ...args);


// ====== Meet joining ======
async function joinMeeting(page, meetingUrl, botName) {
    const enterNameField = 'input[type="text"][aria-label="Your name"]';
    const joinButtonSelectors = [
        '//button[.//span[text()="Join now"]]',
        '//button[.//span[text()="Ask to join"]]',
        '//button[.//span[text()="Tham gia ngay"]]',
        '//button[.//span[text()="Tham gia"]]',
        '//button[.//span[text()="Rejoindre"]]',
        '//button[.//span[text()="Beitreten"]]',
        '//button[.//span[text()="Participar ahora"]]',
        '//button[.//span[text()="参加"]]',
        '//button[.//span[text()="지금 참여"]]',
        '//button[.//span[text()="Присоединиться"]]',
        '//button[.//span[text()="เข้าร่วม"]]',
        '//button[.//span[text()="现在加入"]]',
        '//button[.//span[contains(text(), "Join")]]',
        '//button[.//span[contains(text(), "Tham gia")]]',
        'button[data-mdc-dialog-action="join"]',
        '._3quh._30yy._2t_',
        '//button[contains(@class, "join-button")]'
    ];

    const muteButton = '[aria-label*="Turn off microphone"], [aria-label*="Tắt micrô"], [aria-label*="Mute"], [aria-label*="Stummschalten"]';
    const cameraOffButton = '[aria-label*="Turn off camera"], [aria-label*="Tắt camera"], [aria-label*="Video aus"], [aria-label*="カメラをオフ"]';

    await page.goto(meetingUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.bringToFront();
    log('Wait settle...');
    await page.waitForTimeout(5000);

    log('Find name input...');
    await page.waitForSelector(enterNameField, { timeout: 120000 });
    await page.fill(enterNameField, botName);

    try { await page.click(muteButton, { timeout: 200 }); } catch { }
    await page.waitForTimeout(200);
    try { await page.click(cameraOffButton, { timeout: 200 }); } catch { }
    await page.waitForTimeout(200);

    let joined = false;
    for (const sel of joinButtonSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 10000 });
            await page.click(sel);
            log(`Joined using selector: ${sel}`);
            joined = true; break;
        } catch { }
    }
    if (!joined) throw new Error('Join button not found with provided selectors');
}

async function waitForMeetingAdmission(page, timeoutMs) {
    const leaveButtonSelectors = [
        '//button[@aria-label="Leave call"]',
        '//button[@aria-label="Rời khỏi cuộc gọi"]',
        '//button[@aria-label="Quitter l\'appel"]',
        '//button[@aria-label="Verlassen"]',
        '//button[@aria-label="Salir de la llamada"]',
        '//button[@aria-label="通話を終了"]',
        '//button[@aria-label="통화 종료"]',
        '//button[@aria-label="Покинуть вызов"]',
        '//button[@aria-label="ออกจากสาย"]',
        '//button[@aria-label="离开通话"]',
        '[aria-label*="Leave"]',
        '[aria-label*="Rời khỏi"]',
        '[aria-label*="Quitter"]',
        '[aria-label*="Verlassen"]'
    ];
    const slice = Math.max(2000, Math.floor(timeoutMs / leaveButtonSelectors.length));
    for (const sel of leaveButtonSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: slice });
            log('Admitted (leave button visible)');
            return;
        } catch { }
    }
    throw new Error('Not admitted within timeout');
}

// ====== Main flow ======
async function recordGoogleMeet(meetingUrl, botName, recordSeconds = RECORD_SECONDS_DEFAULT) {
    log('Launch browser...');
    const browser = await chromium.launch({
        headless: false,
        args: [
            // IMPORTANT: do NOT use fake media flags for real audio
            // '--use-fake-ui-for-media-stream',
            // '--use-fake-device-for-media-stream',
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--disable-accelerated-2d-canvas',
            '--no-zygote',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows'
        ],
    });

    try {
        const context = await browser.newContext({
            permissions: ['camera', 'microphone'],
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.170 Safari/537.36',
            viewport: { width: 1280, height: 720 }
        });

        context.on('page', p => {
            p.on('crash', () => console.error('[page] CRASHED'));
            p.on('pageerror', err => console.error('[pageerror]', err?.message));
            p.on('console', msg => console.log('[page]', msg.type(), msg.text()));
            p.on('requestfailed', r => console.warn('[requestfailed]', r.url(), r.failure()?.errorText));
        });

        const page = await context.newPage();

        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Chrome PDF Viewer' }],
            });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
            Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
            Object.defineProperty(window, 'innerWidth', { get: () => 1920 });
            Object.defineProperty(window, 'innerHeight', { get: () => 1080 });
            Object.defineProperty(window, 'outerWidth', { get: () => 1920 });
            Object.defineProperty(window, 'outerHeight', { get: () => 1080 });

            window.initialData = {
                websocketPort: 8765,
                videoFrameWidth: 1200,
                videoFrameHeight: 800,
                botName: 'HopFast',
                addClickRipple: false,
                recordingView: false,
                sendMixedAudio: true,
                sendPerParticipantAudio: true,
                collectCaptions: true
            };
        });

        //google_meet_chromedriver_payload need have libs to runs
        const pbPath   = path.join(__dirname, 'scripts', 'protobuf.min.js');
        const pakoPath = path.join(__dirname, 'scripts', 'pako.min.js');
        await page.addInitScript({ path: pbPath });
        await page.addInitScript({ path: pakoPath });
        
        const hookPath = path.join(__dirname, 'scripts', 'google_meet_chromedriver_payload.js');
        if (!fs.existsSync(hookPath)) {
            console.error('Missing hook at', hookPath);
            process.exit(2);
        }
        await page.addInitScript({ path: hookPath });

        log('Join meeting...');
        await joinMeeting(page, meetingUrl, botName);

        // init websocket client after joined meeting room
        await page.evaluate(() => window._initwsc && window._initwsc());

        log('Wait admission...');
        await waitForMeetingAdmission(page, 300000); // 5 mins

        log('Wait UI stabilize...');
        await page.waitForTimeout(8000);

        await page.waitForTimeout(recordSeconds * 1000 + 3000);
        log('Done. Check recordings folder.');
    } catch (e) {
        log('Error:', e.message);
    }
     finally {
        await browser.close();
        log('Browser closed.');
    }
}

// ====== CLI ======
if (require.main === module) {
    const meetingUrl = process.argv[2] || 'https://meet.google.com/your-meeting-url';
    const botName = process.argv[3] || 'Hopfast';
    const secs = Number(process.argv[4] || RECORD_SECONDS_DEFAULT);
    recordGoogleMeet(meetingUrl, botName, secs);
}

module.exports = { recordGoogleMeet };
