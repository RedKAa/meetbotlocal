// botv3.js
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const stealth = StealthPlugin();
stealth.enabledEvasions.delete('iframe.contentWindow');
stealth.enabledEvasions.delete('media.codecs');
chromium.use(stealth);

const OUTPUT_DIR = path.join(__dirname, 'recordings');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });


// ====== Helpers ======
const log = (...args) => console.log('[meet]', ...args);
const randomDelay = (ms) => ms + Math.floor(Math.random() * (ms / 3 + 1));
const isoStamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ---- FS helpers ----
async function ensureDir(p) { await fsp.mkdir(p, { recursive: true }); }

const writeQueues = new Map();
async function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  await ensureDir(dir);

  const run = async () => {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const data = JSON.stringify(obj, null, 2);
    await fsp.writeFile(tmp, data);
    try {
      await fsp.rename(tmp, file);                 // same-volume atomic swap
    } catch (err) {
      if (err.code === 'EXDEV') {                  // cross-volume fallback
        await fsp.copyFile(tmp, file);
        await fsp.unlink(tmp);
      } else {
        throw err;
      }
    }
  };
  const prev = writeQueues.get(file) || Promise.resolve();
  const p = prev.then(run).finally(() => {
    if (writeQueues.get(file) === p) writeQueues.delete(file);
  });
  writeQueues.set(file, p);
  return p;
}
async function appendLine(file, line) {
  await fsp.appendFile(file, line.endsWith('\n') ? line : line + '\n');
}

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

const writers = new Map();
function openWriter(key, baseDir, meta = {}) {
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  const safe = key.replace(/[^a-z0-9_\-\.]/gi, '_');
  const rawPath = path.join(baseDir, `track_${safe}.pcm16le.raw`);
  const wavPath = rawPath.replace('.raw', '.wav');
  const fd = fs.openSync(rawPath, 'w');
  const sampleRate = Number(meta.sample_rate) || 48000; // WebRTC thường 48000
  const channels = Number(meta.channels) || 1;
  writers.set(key, { fd, rawPath, wavPath, bytes: 0, meta });
}
function writeChunk(key, u8arr) {
  const w = writers.get(key); if (!w) return;
  const buf = Buffer.from(u8arr); fs.writeSync(w.fd, buf); w.bytes += buf.length;
}
function closeWriter(key, rate = 16000) {
  const w = writers.get(key); if (!w) return;
  fs.closeSync(w.fd);
  const rrate = w.meta?.sample_rate || rate;
  finalizeRawToWav(w.rawPath, w.wavPath, rrate);
  writers.delete(key);
}


// ---- RecordingSession: quản lý JSON/log ----
class RecordingSession {
  constructor(baseDir, meta) {
    this.baseDir = baseDir;
    this.tracksDir = path.join(baseDir, 'tracks');
    this.partsDir  = path.join(baseDir, 'participants');
    this.activityLog = path.join(baseDir, 'activity.log');
    this.metaFile = path.join(baseDir, 'meeting_metadata.json');
    this.summaryFile = path.join(baseDir, 'participants_summary.json');
    this.tracksIndex = path.join(this.tracksDir, 'tracks_index.json');

    this.meta = {
      meeting_url: meta.url,
      bot_name: meta.botName,
      started_at: new Date().toISOString(),
      run_id: meta.runId,
    };
    this.tracks = {};       // key -> { trackId, streamId, mid, started_at, ended_at?, wav, meta }
    this.participants = {}; // id -> { id, display_name, first_seen, last_seen }
  }

  async init() {
    await ensureDir(this.baseDir);
    await ensureDir(this.tracksDir);
    await ensureDir(this.partsDir);
    await writeJsonAtomic(this.metaFile, this.meta);
    await writeJsonAtomic(this.tracksIndex, this.tracks);
    await writeJsonAtomic(this.summaryFile, this.participants);
  }

  async onTrackOpen(payload) {
    const { key, trackId, streamId, mid } = payload || {};
    if (!key) return;
    this.tracks[key] = {
      key, trackId: trackId || null, streamId: streamId || null, mid: mid || null,
      started_at: new Date().toISOString(),
      wav: `track_${key}.wav`,
      meta: `track_${key}.json`
    };
    await writeJsonAtomic(this.tracksIndex, this.tracks);
    await appendLine(this.activityLog, `[${new Date().toISOString()}] track-open ${key} trackId=${trackId||''} mid=${mid||''} stream=${streamId||''}`);
    await writeJsonAtomic(path.join(this.tracksDir, this.tracks[key].meta), this.tracks[key]);
  }

  async onTrackMeta(p) {
    const { key, sample_rate, channels } = p || {};
    if (!key || !this.tracks[key]) return;
    if (sample_rate) this.tracks[key].sample_rate = sample_rate;
    if (channels) this.tracks[key].channels = channels;
    await writeJsonAtomic(this.tracksIndex, this.tracks);
    await writeJsonAtomic(path.join(this.tracksDir, this.tracks[key].meta), this.tracks[key]);
  }

  async onTrackClose(payload) {
    const { key } = payload || {};
    if (!key || !this.tracks[key]) return;
    this.tracks[key].ended_at = new Date().toISOString();
    await writeJsonAtomic(this.tracksIndex, this.tracks);
    await appendLine(this.activityLog, `[${new Date().toISOString()}] track-close ${key}`);
    await writeJsonAtomic(path.join(this.tracksDir, this.tracks[key].meta), this.tracks[key]);
  }

  async onParticipants(arr = []) {
    const now = new Date().toISOString();
    for (const p of arr) {
      const id = p.participant_id || p.id;
      if (!id) continue;
      const display_name = p.display_name || p.name || 'Unknown';
      const pdir = path.join(this.partsDir, id);
      if (!this.participants[id]) {
        this.participants[id] = { id, display_name, first_seen: now, last_seen: now };
        await ensureDir(pdir);
        await appendLine(this.activityLog, `[${now}] participant-add ${id} "${display_name}"`);
      } else {
        this.participants[id].display_name = display_name;
        this.participants[id].last_seen = now;
      }
      await writeJsonAtomic(path.join(pdir, 'info.json'), this.participants[id]);
    }
    await writeJsonAtomic(this.summaryFile, this.participants);
  }

  async end() {
    this.meta.ended_at = new Date().toISOString();
    await writeJsonAtomic(this.metaFile, this.meta);
  }
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
  await page.waitForSelector(enterNameField, { timeout: 10000 });
  await page.fill(enterNameField, botName);

  try { await page.click(muteButton, { timeout: 3000 }); } catch {}
  await page.waitForTimeout(200);
  try { await page.click(cameraOffButton, { timeout: 3000 }); } catch {}
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


// ==== Main ====
async function recordGoogleMeet(meetingUrl, botName = 'Bot', seconds = 60) {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
    ],
  });

  const context = await browser.newContext({
    permissions: ['microphone', 'camera'],
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  // expose writer functions
  const runId = (Date.now()).toString(36);
  const meetingDir = path.join(OUTPUT_DIR, `meeting_${runId}`);
  await ensureDir(meetingDir);
  const trackDir = path.join(meetingDir, 'tracks');
  await ensureDir(trackDir);

  const session = new RecordingSession(meetingDir, { url: meetingUrl, botName, runId });
  await session.init();

  await page.exposeFunction('webrtcOpenTrack', (key, meta) =>
    openWriter(key, trackDir, meta)
  );
  await page.exposeFunction('webrtcWriteTrack', (key, u8) =>
    writeChunk(key, Uint8Array.from(u8))
  );
  await page.exposeFunction('webrtcCloseTrack', (key) =>
    closeWriter(key, 16000)
  );
  await page.exposeFunction('botLog', (m) => console.log('[browser]', m));

  await page.exposeFunction('webrtcEvent', async (type, payload) => {
    try {
      if (type === 'track-open') await session.onTrackOpen(payload);
      else if (type === 'track-meta')   await session.onTrackMeta(payload);
      else if (type === 'track-close') await session.onTrackClose(payload);
      else if (type === 'participants') await session.onParticipants(payload);
    } catch (e) {
      console.error('webrtcEvent error', type, e);
    }
  });

  // await page.addInitScript(() => {
  //   try { if (!String(location.hostname||'').endsWith('meet.google.com')) return;
  //     Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  //   } catch {}
  // });

  // const hookPath = path.join(__dirname, 'scripts', 'webrtc-hook.js');
  // if (!fs.existsSync(hookPath)) throw new Error(`Missing ${hookPath}`);
  // await page.addInitScript({ path: hookPath });

  const hookMiniPath = path.join(__dirname, 'scripts', 'hook-mini.js');
  await page.addInitScript({ path: hookMiniPath });

  // ==== JOIN MEETING (giữ logic cũ từ meetbot.js) ====
   log('Join meeting...');
   await joinMeeting(page, meetingUrl, botName);

   // await page.evaluate(() => window.webrtcActivate && window.webrtcActivate());

   await page.evaluate(() => window.webrtcMini && window.webrtcMini.activate());

   log('Wait admission...');
   await waitForMeetingAdmission(page, 300000); // 5 mins

  // ==== GHI TRONG N GIÂY ====
   log('Wait UI stabilize...');
   await page.waitForTimeout(8000 + seconds*1000);

  // finalize writers
  for (const key of Array.from(writers.keys())) {
   closeWriter(key, 16000);
  }
  await session.end();

  try {
    await page.click('[aria-label*="Leave"], [aria-label*="Rời khỏi"], button[aria-label="Leave call"]', { timeout: 3000 });
    log('Left meeting');
  } catch {}

  await browser.close();
  console.log('Done:', meetingDir);
}

// CLI usage
if (require.main === module) {
  const url = process.argv[2];
  const name = process.argv[3] || 'Hopfast';
  const secs = Number(process.argv[4] || 30);
  if (!url) {
    console.error('Usage: node botv3.js <meet_url> [botName] [seconds]');
    process.exit(1);
  }
  recordGoogleMeet(url, name, secs).catch((e) => console.error(e));
}

module.exports = { recordGoogleMeet };
