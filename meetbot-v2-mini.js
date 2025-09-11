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
const randomDelay = (ms) => ms + Math.floor(Math.random() * (ms / 3 + 1));
const isoStamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// WAV header writer for PCM 16-bit mono
function writeWavHeader(fd, dataLength, sampleRate = 16000) {
  const blockAlign = 2; // mono * 16-bit
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20);  // PCM format
  header.writeUInt16LE(1, 22);  // channels = 1
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  fs.writeSync(fd, header);
}

function finalizeRawToWav(rawPath, wavPath, sampleRate = 16000) {
  const stat = fs.statSync(rawPath);
  const dataLen = stat.size; // bytes of PCM16LE
  const wavFd = fs.openSync(wavPath, 'w');
  writeWavHeader(wavFd, dataLen, sampleRate);
  const rawFd = fs.openSync(rawPath, 'r');
  const bufSize = 1 << 20; // 1MB
  const buf = Buffer.allocUnsafe(bufSize);
  let bytesRead;
  while ((bytesRead = fs.readSync(rawFd, buf, 0, bufSize, null)) > 0) {
    fs.writeSync(wavFd, buf, 0, bytesRead);
  }
  fs.closeSync(rawFd);
  fs.closeSync(wavFd);
}

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

  await page.goto(meetingUrl, { waitUntil: 'networkidle' });
  await page.bringToFront();
  log('Wait settle...');
  await page.waitForTimeout(5000);

  log('Find name input...');
  await page.waitForSelector(enterNameField, { timeout: 120000 });
  await page.fill(enterNameField, botName);

  try { await page.click(muteButton, { timeout: 200 }); } catch {}
  await page.waitForTimeout(200);
  try { await page.click(cameraOffButton, { timeout: 200 }); } catch {}
  await page.waitForTimeout(200);

  let joined = false;
  for (const sel of joinButtonSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 10000 });
      await page.click(sel);
      log(`Joined using selector: ${sel}`);
      joined = true; break;
    } catch {}
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
    } catch {}
  }
  throw new Error('Not admitted within timeout');
}

// ====== Recording (Audio-only via DOM) ======
async function startAudioDomRecording(page, recordSeconds, audioRawPath, audioWavPath) {
  log('Start DOM audio capture...');

  // Expose a binary-ish bridge: send arrays of numbers -> write to file as Buffer
  const audioWriteStream = fs.createWriteStream(audioRawPath);

  await page.exposeFunction('sendAudioChunk', (arr) => {
    try {
      const u8 = Uint8Array.from(arr);
      audioWriteStream.write(Buffer.from(u8));
    } catch (e) {
      log('write audio error:', e.message);
    }
  });

  await page.exposeFunction('closeAudioFile', async () => {
    audioWriteStream.end();
    try {
      finalizeRawToWav(audioRawPath, audioWavPath, 16000);
      log('WAV saved:', audioWavPath);
    } catch (e) {
      log('Finalize WAV error:', e.message);
    }
  });

  await page.exposeFunction('logBot', (m) => log('[browser]', m));

  // Inject recorder in the Meet tab
  await page.evaluate(async (seconds) => {
    const SAMPLE_RATE_OUT = 16000;

    function f32ToI16LEBytes(f32) {
      const buf = new ArrayBuffer(f32.length * 2);
      const view = new DataView(buf);
      for (let i = 0; i < f32.length; i++) {
        let s = Math.max(-1, Math.min(1, f32[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      }
      return new Uint8Array(buf);
    }

    window.logBot('Searching media elements...');
    const mediaEls = Array.from(document.querySelectorAll('audio,video'))
      .filter(el => el.srcObject instanceof MediaStream &&
                    el.srcObject.getAudioTracks().length > 0);

    if (!mediaEls.length) {
      window.logBot('No active media elements with audio found.');
      throw new Error('No audio sources');
    }
    window.logBot(`Found ${mediaEls.length} audio-capable media elements.`);

    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination();

    let connected = 0;
    for (const [i, el] of mediaEls.entries()) {
      try {
        const s = el.srcObject || el.captureStream?.() || el.mozCaptureStream?.();
        if (s && s.getAudioTracks().length) {
          const src = ac.createMediaStreamSource(s);
          src.connect(dest);
          connected++;
          window.logBot(`Connected element #${i + 1}`);
        }
      } catch (e) {
        window.logBot(`Connect failed #${i + 1}: ${e.message}`);
      }
    }
    if (!connected) {
      window.logBot('Could not connect any streams');
      throw new Error('No connected streams');
    }

    const proc = ac.createScriptProcessor(4096, 1, 1);
    const mixed = ac.createMediaStreamSource(dest.stream);
    mixed.connect(proc);
    const sink = ac.createGain(); sink.gain.value = 0;
    proc.connect(sink); sink.connect(ac.destination);

    window.logBot(`AudioContext sampleRate: ${ac.sampleRate}`);
    const ratio = SAMPLE_RATE_OUT / ac.sampleRate;

    let running = true;
    const stopAt = Date.now() + seconds * 1000;

    proc.onaudioprocess = async (ev) => {
      if (!running) return;
      const inF32 = ev.inputBuffer.getChannelData(0);
      const outLen = Math.max(1, Math.round(inF32.length * ratio));
      const outF32 = new Float32Array(outLen);

      if (outLen === 1) {
        outF32[0] = inF32[0];
      } else {
        const spring = (inF32.length - 1) / (outLen - 1);
        outF32[0] = inF32[0];
        outF32[outLen - 1] = inF32[inF32.length - 1];
        for (let i = 1; i < outLen - 1; i++) {
          const idx = i * spring, li = Math.floor(idx), ri = Math.ceil(idx), f = idx - li;
          outF32[i] = inF32[li] + (inF32[ri] - inF32[li]) * f;
        }
      }

      try {
        const i16 = f32ToI16LEBytes(outF32);
        // Send as plain array of numbers (Playwright serializes)
        await window.sendAudioChunk(Array.from(i16));
      } catch (e) {
        window.logBot('sendAudioChunk error: ' + e.message);
      }

      if (Date.now() >= stopAt) {
        running = false;
        try {
          proc.disconnect();
        } catch {}
        try {
          window.logBot('Audio capture stopping...');
          await window.closeAudioFile();
          window.logBot('Audio file closed.');
        } catch (e) {
          window.logBot('closeAudioFile error: ' + e.message);
        }
      }
    };

    window.logBot('Audio DOM capture started.');
  }, recordSeconds);
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
    });

    //!IMPORTANT inject script vào trình duyệt
    const hookMiniPath = path.join(__dirname, 'scripts', 'hook-mini.js');
    await page.addInitScript({ path: hookMiniPath });

    log('Join meeting...');
    await joinMeeting(page, meetingUrl, botName);

    //!IMPORTANT bật cờ ACTIVE để script trong hook-mini.js chạy
    await page.evaluate(() => window.webrtcMini && window.webrtcMini.activate());

    log('Wait admission...');
    await waitForMeetingAdmission(page, 300000); // 5 mins

    log('Wait UI stabilize...');
    await page.waitForTimeout(8000);

    const ts = isoStamp();
    const audioRaw = path.join(OUTPUT_DIR, `audio-${ts}.pcm16le.raw`);
    const audioWav = path.join(OUTPUT_DIR, `audio-${ts}.wav`);

    log(`Recording audio for ${recordSeconds}s ->\n  RAW: ${audioRaw}\n  WAV: ${audioWav}`);
    await startAudioDomRecording(page, recordSeconds, audioRaw, audioWav);

    // Wait a bit more than recording time for browser-side to flush
    await page.waitForTimeout(recordSeconds * 1000 + 3000);
    log('Done. Check recordings folder.');
  } catch (e) {
    log('Error:', e.message);
  } finally {
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
