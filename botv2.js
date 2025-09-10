// meetbot-v2.js - Google Meet Bot with per-participant audio capture
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

// ====== Config ======
const OUTPUT_DIR = path.join(__dirname, 'recordings');
const RECORD_SECONDS_DEFAULT = 30;
const SILENCE_THRESHOLD = 0.0001; // Threshold for silence detection
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ====== Global state ======
let meetingDir = null;
let participantsDir = null;
let mixedAudioWriteStream = null;
let mixedAudioRawPath = null;
let mixedAudioWavPath = null;
let participantAudioStreams = new Map(); // Map<participantId, {writeStream, rawPath, wavPath, trackId, startTime, lastActivity}>
let participantMetadata = new Map(); // Map<participantId, {participant_id, display_name, join_time, leave_time, total_speaking_time, tracks}>
let meetingMetadata = {
  meeting_id: null,
  meeting_url: null,
  start_time: null,
  end_time: null,
  participants: []
};

// RTC management
let userManager = null;
let receiverManager = null;
let rtcInterceptor = null;
let rtpReceiverInterceptor = null;
let participantExtractInterval = null;

// ====== RTC Interceptors ======
class RTCRtpReceiverInterceptor {
  constructor() {
    this.receivers = new Map(); // Map<receiverId, receiver>
  }

  install() {
    const self = this;
    const originalGetContributingSources = RTCRtpReceiver.prototype.getContributingSources;

    // Override getContributingSources method
    RTCRtpReceiver.prototype.getContributingSources = function() {
      const sources = originalGetContributingSources.call(this);
      
      // Store receiver reference for later use
      if (!this._id) {
        this._id = `receiver_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        self.receivers.set(this._id, this);
      }
      
      return sources;
    };
    
    log('RTCRtpReceiverInterceptor: Installed RTCRtpReceiver interceptor');
  }

  getReceivers() {
    return Array.from(this.receivers.values());
  }
}

class RTCInterceptor {
  constructor() {
    this.peerConnections = new Set();
    this.onTrackCallbacks = [];
  }

  install() {
    const self = this;
    const originalRTCPeerConnection = window.RTCPeerConnection;

    // Override RTCPeerConnection constructor
    window.RTCPeerConnection = function(...args) {
      const pc = new originalRTCPeerConnection(...args);
      self.peerConnections.add(pc);
      
      // Intercept track events
      const originalAddEventListener = pc.addEventListener;
      pc.addEventListener = function(type, listener, options) {
        if (type === 'track') {
          const wrappedListener = (e) => {
            // Call original listener
            listener(e);
            
            // Call our callbacks
            self.onTrackCallbacks.forEach(callback => {
              try {
                callback(e, pc);
              } catch (err) {
                console.error('Error in track callback:', err);
              }
            });
          };
          return originalAddEventListener.call(this, type, wrappedListener, options);
        }
        return originalAddEventListener.call(this, type, listener, options);
      };
      
      return pc;
    };
    
    // Copy static properties
    for (const prop in originalRTCPeerConnection) {
      if (originalRTCPeerConnection.hasOwnProperty(prop)) {
        window.RTCPeerConnection[prop] = originalRTCPeerConnection[prop];
      }
    }
    
    window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
    window.RTCPeerConnection.prototype.constructor = window.RTCPeerConnection;
    
    log('RTCInterceptor: Installed RTCPeerConnection interceptor');
  }

  onTrack(callback) {
    this.onTrackCallbacks.push(callback);
  }

  getPeerConnections() {
    return Array.from(this.peerConnections);
  }
}

// ====== Stealth ======
const stealth = StealthPlugin();
stealth.enabledEvasions.delete('iframe.contentWindow');
stealth.enabledEvasions.delete('media.codecs');
chromium.use(stealth);

// ====== Helpers ======
const log = (...args) => console.log('[meet]', ...args);
const randomDelay = (ms) => ms + Math.floor(Math.random() * (ms / 3 + 1));
const isoStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const sanitizeFilename = (name) => name.replace(/[\/:*?"<>|]/g, '_');

// Audio processing helpers
function convertFloat32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    // Convert float32 [-1.0, 1.0] to int16 [-32768, 32767]
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return int16Array;
}

function calculateMaxAmplitude(float32Array) {
  let max = 0;
  for (let i = 0; i < float32Array.length; i++) {
    const absValue = Math.abs(float32Array[i]);
    if (absValue > max) {
      max = absValue;
    }
  }
  return max;
}

function convertToMono(audioData, numberOfChannels) {
  if (numberOfChannels === 1) {
    return audioData;
  }
  
  // For multi-channel audio, average all channels
  const monoData = new Float32Array(audioData.length / numberOfChannels);
  for (let i = 0; i < monoData.length; i++) {
    let sum = 0;
    for (let channel = 0; channel < numberOfChannels; channel++) {
      sum += audioData[i * numberOfChannels + channel];
    }
    monoData[i] = sum / numberOfChannels;
  }
  return monoData;
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

// ====== Recording (RTC-based Audio) ======
async function startRTCAudioRecording(page, recordSeconds, meetingId) {
  log('Start RTC audio capture...');
  
  // Create meeting directory structure
  const timestamp = isoStamp();
  meetingDir = path.join(OUTPUT_DIR, `meeting_${meetingId}_${timestamp}`);
  participantsDir = path.join(meetingDir, 'participants');
  
  fs.mkdirSync(meetingDir, { recursive: true });
  fs.mkdirSync(participantsDir, { recursive: true });
  
  // Mixed audio file paths (for backward compatibility)
  mixedAudioRawPath = path.join(meetingDir, 'mixed_audio.pcm16le.raw');
  mixedAudioWavPath = path.join(meetingDir, 'mixed_audio.wav');
  mixedAudioWriteStream = fs.createWriteStream(mixedAudioRawPath);
  
  // Initialize managers and interceptors
  // Note: UserManager and ReceiverManager are defined globally
  // but we need to expose them to the page context
  await page.evaluate(() => {
    // Define UserManager and ReceiverManager classes in browser context
    class UserManager {
      constructor() {
        this.users = new Map(); // participantId -> {displayName, deviceId, streamId}
        this.streamToParticipant = new Map(); // streamId -> participantId
      }
      
      addUser(participantId, displayName) {
        if (!this.users.has(participantId)) {
          this.users.set(participantId, {
            participantId,
            displayName: displayName || 'Unknown',
            streamIds: new Set(),
            joinTime: new Date().toISOString()
          });
          window.logBot(`User added: ${displayName} (${participantId})`);
          
          // Update meeting metadata when adding new participant
          try {
            window.updateMeetingParticipants({
              participant_id: participantId,
              display_name: displayName || 'Unknown',
              join_time: new Date().toISOString()
            });
          } catch (e) {
            window.logBot(`Error updating meeting metadata: ${e.message}`);
          }
        }
        return this.users.get(participantId);
      }
      
      getUser(participantId) {
        return this.users.get(participantId);
      }
      
      associateStream(participantId, streamId) {
        if (!streamId) return;
        
        const user = this.users.get(participantId);
        if (user) {
          user.streamIds.add(streamId);
          this.streamToParticipant.set(streamId, participantId);
          window.logBot(`Stream ${streamId} associated with user ${user.displayName}`);
        }
      }
      
      getParticipantByStreamId(streamId) {
        return this.streamToParticipant.get(streamId);
      }
      
      getFirstParticipant() {
        const firstEntry = this.users.entries().next().value;
        return firstEntry ? { participantId: firstEntry[0], ...firstEntry[1] } : null;
      }
      
      extractParticipantsFromDOM() {
        // Extract participants from DOM
        const participantElements = document.querySelectorAll('[data-participant-id]');
        if (participantElements.length === 0) {
          window.logBot('No participant elements found, will try again later');
          return;
        }
        
        participantElements.forEach(el => {
          const participantId = el.getAttribute('data-participant-id');
          const displayName = el.getAttribute('data-display-name') || 'Unknown';
          this.addUser(participantId, displayName);
        });
      }
    }
    
    class ReceiverManager {
      constructor() {
        this.receivers = new Map(); // receiverId -> {track, streamId}
        this.streamToReceiver = new Map(); // streamId -> receiverId
      }
      
      addReceiver(receiver, track) {
        const receiverId = this.getReceiverId(receiver);
        const streamId = track.id;
        
        this.receivers.set(receiverId, {
          receiver,
          track,
          streamId
        });
        
        this.streamToReceiver.set(streamId, receiverId);
        window.logBot(`ReceiverManager: Added receiver for stream ${streamId}`);
        return receiverId;
      }
      
      getReceiverId(receiver) {
        return receiver._id || `receiver_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      }
      
      getReceiverByStreamId(streamId) {
        const receiverId = this.streamToReceiver.get(streamId);
        if (receiverId) {
          return this.receivers.get(receiverId);
        }
        return null;
      }
    }
    
    // Create global instances in browser context
    window.userManager = new UserManager();
    window.receiverManager = new ReceiverManager();
  });
  
  // Create local references for Node.js context
  userManager = { extractParticipantsFromDOM: () => {} };
  receiverManager = {};
  
  // Set up participant extraction interval
  participantExtractInterval = setInterval(async () => {
    try {
      await page.evaluate(() => {
        if (window.userManager && typeof window.userManager.extractParticipantsFromDOM === 'function') {
          return window.userManager.extractParticipantsFromDOM();
        }
      });
    } catch (e) {
      log('Error extracting participants:', e.message);
    }
  }, 10000); // Extract participants every 10 seconds
  
  // Create meeting metadata file
  const meetingMetadata = {
    meeting_id: meetingId,
    meeting_url: page.url(),
    start_time: new Date().toISOString(),
    end_time: null,
    participants: []
  };
  
  fs.writeFileSync(
    path.join(meetingDir, 'meeting_metadata.json'),
    JSON.stringify(meetingMetadata, null, 2)
  );
  
  // Expose function to update meeting metadata with participants
  await page.exposeFunction('updateMeetingParticipants', (participantData) => {
    // Handle both single participant and array of participants
    const participants = Array.isArray(participantData) ? participantData : [participantData];
    
    participants.forEach(participant => {
      // Clean up display name if needed
      if (participant.display_name) {
        participant.display_name = cleanDisplayName(participant.display_name);
      }
      
      // Check if participant already exists
      const existingIndex = meetingMetadata.participants.findIndex(
        p => p.participant_id === participant.participant_id
      );
      
      if (existingIndex >= 0) {
        // Update existing participant
        meetingMetadata.participants[existingIndex] = {
          ...meetingMetadata.participants[existingIndex],
          ...participant
        };
      } else {
        // Add new participant
        meetingMetadata.participants.push(participant);
      }
      
      log(`Updated meeting metadata: ${participant.display_name}`);
    });
    
    // Update meeting metadata file
    fs.writeFileSync(
      path.join(meetingDir, 'meeting_metadata.json'),
      JSON.stringify(meetingMetadata, null, 2)
    );
  });
  
  // Helper function to clean display names
  function cleanDisplayName(name) {
    // Remove common UI element texts
    const uiElements = [
      'keep_outline', 'Pin', 'mic_none', 'mic_off', 
      'You can\'t remotely mute this participant', 
      'You can\'t unmute someone else',
      'more_vert', 'More options', 
      'visual_effects', 'Backgrounds and effects',
      'Remove this tile', 
      'Others might still see your full video.',
      'devices',
      'You can\'t unmute'
    ];
    
    let cleanName = name;
    
    // Remove each UI element text
    uiElements.forEach(element => {
      cleanName = cleanName.replace(new RegExp(element, 'gi'), '');
    });
    
    // Remove any remaining non-name elements (typically icons represented as text)
    cleanName = cleanName.replace(/[\u2000-\u2FFF\u3000-\u9FFF]/g, '');
    
    // Clean up extra spaces
    cleanName = cleanName.replace(/\s+/g, ' ').trim();
    
    // Look for repeated name patterns (common in Google Meet)
    const words = cleanName.split(' ');
    
    // Check for duplicate name pattern (e.g., "Nguyễn HoàngNguyễn")
    // This is a common pattern in Google Meet where the name appears twice
    // with the second occurrence having no space
    for (let i = 0; i < words.length - 1; i++) {
      const currentWord = words[i];
      const nextWord = words[i + 1];
      
      // Check if the next word contains the current word (case insensitive)
      if (currentWord.length > 1 && nextWord.toLowerCase().includes(currentWord.toLowerCase())) {
        return currentWord; // Return just the name part
      }
      
      // Check if current word contains the next word (case insensitive)
      if (nextWord.length > 1 && currentWord.toLowerCase().includes(nextWord.toLowerCase())) {
        return nextWord; // Return just the name part
      }
    }
    
    // Check for exact repeated words
    const repeatedNameParts = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i].length < 2) continue; // Skip very short words
      
      for (let j = i + 1; j < words.length; j++) {
        if (words[i].toLowerCase() === words[j].toLowerCase()) {
          repeatedNameParts.push(words[i]);
          break;
        }
      }
    }
    
    // If we found repeated name parts, use them
    if (repeatedNameParts.length > 0) {
      return [...new Set(repeatedNameParts)].join(' ');
    }
    
    // If name is too long, it likely still contains UI elements
    if (cleanName.length > 30) {
      // Take first 30 chars or first 3 words
      if (words.length > 3) {
        cleanName = words.slice(0, 3).join(' ');
      } else {
        cleanName = cleanName.substring(0, 30);
      }
    }
    
    return cleanName || 'Unknown';
  }

  // Expose functions to browser context
  await page.exposeFunction('sendMixedAudioChunk', (arr) => {
    try {
      const u8 = Uint8Array.from(arr);
      mixedAudioWriteStream.write(Buffer.from(u8));
    } catch (e) {
      log('Write mixed audio error:', e.message);
    }
  });
  
  await page.exposeFunction('sendParticipantAudioChunk', async (participantId, displayName, arr) => {
    try {
      // Debug log to track participant audio chunks
      log(`Received audio chunk for participant: ${displayName} (${participantId}) - size: ${arr.length} bytes`);
      
      // Check if the audio chunk is valid
      if (!arr || arr.length === 0) {
        log(`Invalid audio chunk for ${participantId}: empty array`);
        return;
      }
      
      // Sanitize participant name for file system
      const safeDisplayName = sanitizeFilename(displayName || 'unknown');
      const participantDirName = `${safeDisplayName}_${participantId}`;
      const participantDir = path.join(participantsDir, participantDirName);
      
      log(`Participant directory path: ${participantDir}`);
      
      // Create participant directory if it doesn't exist
      if (!fs.existsSync(participantDir)) {
        log(`Creating directory for participant: ${displayName} (${participantId})`);
        try {
          // Force create directories with explicit error handling
          fs.mkdirSync(participantDir, { recursive: true });
          log(`Created participant directory: ${participantDir}`);
          
          // Create audio tracks directory structure
          const audioTracksDir = path.join(participantDir, 'audio_tracks');
          fs.mkdirSync(audioTracksDir, { recursive: true });
          log(`Created audio tracks directory: ${audioTracksDir}`);
          
          // Create separate directories for raw and processed audio
          const rawAudioDir = path.join(audioTracksDir, 'raw');
          const processedAudioDir = path.join(audioTracksDir, 'processed');
          const wavAudioDir = path.join(audioTracksDir, 'wav');
          
          fs.mkdirSync(rawAudioDir, { recursive: true });
          fs.mkdirSync(processedAudioDir, { recursive: true });
          fs.mkdirSync(wavAudioDir, { recursive: true });
          
          log(`Created audio subdirectories for ${displayName}`);
          
          // Verify directories were created
          if (!fs.existsSync(participantDir) || !fs.existsSync(audioTracksDir) ||
              !fs.existsSync(rawAudioDir) || !fs.existsSync(processedAudioDir) || !fs.existsSync(wavAudioDir)) {
            throw new Error(`Failed to verify directory creation for ${participantId}`);
          }
          
          log(`Successfully created directories for ${displayName}`);
          
          // Add user to UserManager if not already added
          if (userManager && !userManager.getUser(participantId)) {
            userManager.addUser(participantId, displayName);
          }
        } catch (dirError) {
          log(`ERROR creating directories for ${displayName}: ${dirError.message}`);
          log(`ERROR stack: ${dirError.stack}`);
          return; // Exit early if we can't create directories
        }
        
        // Initialize participant metadata
        const participantInfo = {
          participant_id: participantId,
          display_name: displayName || 'unknown',
          join_time: new Date().toISOString(),
          leave_time: null,
          total_speaking_time: 0,
          tracks: []
        };
        
        participantMetadata.set(participantId, participantInfo);
        try {
          fs.writeFileSync(
            path.join(participantDir, 'info.json'),
            JSON.stringify(participantInfo, null, 2)
          );
        } catch (writeError) {
          log(`ERROR writing participant info: ${writeError.message}`);
        }
        
        // Add to meeting metadata
        meetingMetadata.participants.push({
          participant_id: participantId,
          display_name: displayName || 'unknown',
          join_time: new Date().toISOString(),
          leave_time: null
        });
        
        try {
          fs.writeFileSync(
            path.join(meetingDir, 'meeting_metadata.json'),
            JSON.stringify(meetingMetadata, null, 2)
          );
        } catch (writeError) {
          log(`ERROR writing meeting metadata: ${writeError.message}`);
        }
      }
      
      // Get or create write stream for this participant
      if (!participantAudioStreams.has(participantId)) {
        const trackId = `track_${Date.now()}`;
        const audioTracksDir = path.join(participantDir, 'audio_tracks');
        
        // Double-check audio_tracks directory exists
        if (!fs.existsSync(audioTracksDir)) {
          log(`Audio tracks directory missing, recreating: ${audioTracksDir}`);
          fs.mkdirSync(audioTracksDir, { recursive: true });
          
          // Recreate subdirectories
          const rawAudioDir = path.join(audioTracksDir, 'raw');
          const processedAudioDir = path.join(audioTracksDir, 'processed');
          const wavAudioDir = path.join(audioTracksDir, 'wav');
          
          fs.mkdirSync(rawAudioDir, { recursive: true });
          fs.mkdirSync(processedAudioDir, { recursive: true });
          fs.mkdirSync(wavAudioDir, { recursive: true });
        }
        
        // Use new directory structure
        const rawAudioDir = path.join(audioTracksDir, 'raw');
        const wavAudioDir = path.join(audioTracksDir, 'wav');
        
        const rawPath = path.join(rawAudioDir, `${trackId}.pcm16le.raw`);
        const wavPath = path.join(wavAudioDir, `${trackId}.wav`);
        
        log(`Creating new audio track for ${displayName}: ${trackId} at ${rawPath}`);
        
        try {
          const writeStream = fs.createWriteStream(rawPath);
          
          // Verify stream was created successfully
          if (!writeStream.writable) {
            throw new Error(`Stream not writable for ${rawPath}`);
          }
          
          participantAudioStreams.set(participantId, {
            writeStream,
            rawPath,
            wavPath,
            trackId,
            startTime: new Date().toISOString(),
            lastActivity: Date.now()
          });
          
          // Update participant metadata
          const metadata = participantMetadata.get(participantId);
          if (metadata) {
            metadata.tracks.push({
              track_id: trackId,
              start_time: new Date().toISOString(),
              end_time: null,
              duration: 0,
              raw_path: path.relative(meetingDir, rawPath),
              wav_path: path.relative(meetingDir, wavPath),
              processed_path: path.relative(meetingDir, path.join(path.dirname(path.dirname(rawPath)), 'processed', `${trackId}.processed.raw`)),
              has_silence_detection: true
            });
            
            // Update metadata file
            try {
              fs.writeFileSync(
                path.join(participantDir, 'info.json'),
                JSON.stringify(metadata, null, 2)
              );
            } catch (writeError) {
              log(`ERROR updating participant metadata: ${writeError.message}`);
            }
          }
        } catch (streamError) {
          log(`ERROR creating write stream: ${streamError.message}`);
          return; // Exit early if we can't create the stream
        }
      }
      
      // Write audio chunk
      try {
        const streamInfo = participantAudioStreams.get(participantId);
        if (!streamInfo || !streamInfo.writeStream) {
          throw new Error(`No valid stream for participant ${participantId}`);
        }
        
        streamInfo.lastActivity = Date.now();
        const buffer = Buffer.from(Uint8Array.from(arr));
        
        // Silence detection
        const audioData = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
        let maxAmplitude = 0;
        
        // Calculate max amplitude for silence detection
        for (let i = 0; i < audioData.length; i++) {
          const amplitude = Math.abs(audioData[i]) / 32768.0; // Normalize to 0-1
          if (amplitude > maxAmplitude) {
            maxAmplitude = amplitude;
          }
        }
        
        // Check if this chunk is silent
        const isSilent = maxAmplitude < SILENCE_THRESHOLD;
        
        // Update silence stats in stream info
        if (!streamInfo.silenceStats) {
          streamInfo.silenceStats = {
            totalChunks: 0,
            silentChunks: 0,
            consecutiveSilence: 0,
            lastMaxAmplitude: 0
          };
        }
        
        streamInfo.silenceStats.totalChunks++;
        streamInfo.silenceStats.lastMaxAmplitude = maxAmplitude;
        
        if (isSilent) {
          streamInfo.silenceStats.silentChunks++;
          streamInfo.silenceStats.consecutiveSilence++;
          
          // Log silence detection periodically
          if (streamInfo.silenceStats.consecutiveSilence % 10 === 0) {
            log(`Detected ${streamInfo.silenceStats.consecutiveSilence} consecutive silent chunks for ${displayName}`);
          }
        } else {
          // Reset consecutive silence counter when non-silent chunk is detected
          streamInfo.silenceStats.consecutiveSilence = 0;
        }
        
        // Log the buffer size and first few bytes for debugging
        log(`Writing ${buffer.length} bytes for ${participantId}, first bytes: ${buffer.slice(0, 8).toString('hex')}, silent: ${isSilent}`);
        
        // Skip writing if we have too many consecutive silent chunks (more than 30 = ~3 seconds)
        const skipSilence = isSilent && streamInfo.silenceStats.consecutiveSilence > 30;
        
        // Check if stream is still writable
        if (!streamInfo.writeStream.writable) {
          log(`ERROR: Stream not writable for ${participantId}`);
          return;
        }
        
        if (!skipSilence) {
          // Write the buffer to the raw file
          streamInfo.writeStream.write(buffer);
          
          // If this is a non-silent chunk after silence, update metadata
          if (!isSilent && streamInfo.silenceStats.consecutiveSilence > 0) {
            const metadata = participantMetadata.get(participantId);
            if (metadata && metadata.tracks.length > 0) {
              const currentTrack = metadata.tracks[metadata.tracks.length - 1];
              currentTrack.silence_stats = {
                total_chunks: streamInfo.silenceStats.totalChunks,
                silent_chunks: streamInfo.silenceStats.silentChunks,
                silence_percentage: Math.round((streamInfo.silenceStats.silentChunks / streamInfo.silenceStats.totalChunks) * 100)
              };
              
              // Update metadata file
              try {
                fs.writeFileSync(
                  path.join(participantDir, 'info.json'),
                  JSON.stringify(metadata, null, 2)
                );
              } catch (writeError) {
                log(`ERROR updating silence stats in metadata: ${writeError.message}`);
              }
            }
          }
          log(`Successfully wrote audio chunk for ${participantId}`);
        } else {
          log(`Skipping silent chunk for ${displayName} (${streamInfo.silenceStats.consecutiveSilence} consecutive silent chunks)`);
        }
      } catch (writeError) {
        log(`ERROR writing audio chunk (${participantId}): ${writeError.message}`);
      }
    } catch (e) {
      log(`CRITICAL ERROR in sendParticipantAudioChunk (${participantId}): ${e.message}`);
      log(`Error stack: ${e.stack}`);
    }
  });
  
  await page.exposeFunction('closeAudioFiles', async () => {
    log('Closing audio files and cleaning up resources...');
    
    // Clear participant extraction interval
    if (participantExtractInterval) {
      clearInterval(participantExtractInterval);
      participantExtractInterval = null;
      log('Participant extraction interval cleared');
    }
    
    // Close mixed audio file
    mixedAudioWriteStream.end();
    try {
      finalizeRawToWav(mixedAudioRawPath, mixedAudioWavPath, 16000);
      log('Mixed WAV saved:', mixedAudioWavPath);
    } catch (e) {
      log('Finalize mixed WAV error:', e.message);
    }
    
    // Close all participant audio files
    for (const [participantId, streamInfo] of participantAudioStreams.entries()) {
      try {
        streamInfo.writeStream.end();
        
        // Only finalize if there's actual data
        const stat = fs.statSync(streamInfo.rawPath);
        if (stat.size > 0) {
          finalizeRawToWav(streamInfo.rawPath, streamInfo.wavPath, 16000);
          log(`Participant WAV saved: ${participantId} (${stat.size} bytes)`);
          
          // Update metadata
          const metadata = participantMetadata.get(participantId);
          if (metadata) {
            const track = metadata.tracks.find(t => t.track_id === streamInfo.trackId);
            if (track) {
              track.end_time = new Date().toISOString();
              track.duration = Date.now() - new Date(track.start_time).getTime();
              track.size_bytes = stat.size;
            }
            
            // Write updated metadata
            const participantDirName = `${sanitizeFilename(metadata.display_name)}_${participantId}`;
            const participantDir = path.join(participantsDir, participantDirName);
            fs.writeFileSync(
              path.join(participantDir, 'info.json'),
              JSON.stringify(metadata, null, 2)
            );
          }
        } else {
          log(`Skipping empty audio file for ${participantId}`);
          // Delete empty files
          try {
            fs.unlinkSync(streamInfo.rawPath);
          } catch (e) {}
        }
      } catch (e) {
        log(`Finalize participant WAV error (${participantId}):`, e.message);
      }
    }
    
    // Update meeting end time
    meetingMetadata.end_time = new Date().toISOString();
    fs.writeFileSync(
      path.join(meetingDir, 'meeting_metadata.json'),
      JSON.stringify(meetingMetadata, null, 2)
    );
    
    // Create participants summary from meeting metadata if available
    let participantsSummary = [];
    
    if (meetingMetadata.participants && meetingMetadata.participants.length > 0) {
      // Use meeting metadata participants
      participantsSummary = meetingMetadata.participants.map(p => ({
        participant_id: p.participant_id,
        display_name: p.display_name,
        join_time: p.join_time,
        leave_time: meetingMetadata.end_time
      }));
    } else {
      // Fallback to participant metadata if available
      participantsSummary = Array.from(participantMetadata.values())
        .filter(p => p.tracks.some(t => t.size_bytes && t.size_bytes > 0));
    }
    
    // If still no participants, add a placeholder
    if (participantsSummary.length === 0) {
      participantsSummary.push({
        participant_id: 'mixed_audio',
        display_name: 'Mixed Audio Only',
        join_time: meetingMetadata.start_time,
        leave_time: meetingMetadata.end_time,
        note: 'No individual participant audio was detected. Please check the mixed_audio.wav file.'
      });
    }
    
    // Ensure participants directory exists
    if (!fs.existsSync(participantsDir)) {
      fs.mkdirSync(participantsDir, { recursive: true });
    }
    
    fs.writeFileSync(
      path.join(participantsDir, 'participants_summary.json'),
      JSON.stringify(participantsSummary, null, 2)
    );
    
    log(`All audio files closed. Found ${participantsSummary.length} participants with audio.`);
  });
  
  await page.exposeFunction('logBot', (m) => log('[browser]', m));

  // Inject RTC interceptor and audio processor in the Meet tab
  await page.evaluate(async (seconds) => {
    const SAMPLE_RATE_OUT = 16000;
    const SILENCE_THRESHOLD = 0.0001; // Threshold for silence detection
    
    // Helper function to convert float32 audio to int16 bytes
    function f32ToI16LEBytes(f32) {
      const buf = new ArrayBuffer(f32.length * 2);
      const view = new DataView(buf);
      for (let i = 0; i < f32.length; i++) {
        let s = Math.max(-1, Math.min(1, f32[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      }
      return new Uint8Array(buf);
    }
    
    // Define RTCInterceptor class inside the evaluate function
    class RTCInterceptor {
      constructor() {
        this.peerConnections = new Set();
        this.onTrackCallbacks = [];
      }
      
      install() {
        const originalRTCPeerConnection = window.RTCPeerConnection;
        const self = this;
        
        window.RTCPeerConnection = function(...args) {
          const pc = new originalRTCPeerConnection(...args);
          self.peerConnections.add(pc);
          
          const originalAddTrack = pc.addTrack;
          pc.addTrack = function(...args) {
            window.logBot(`RTCPeerConnection.addTrack called`);
            return originalAddTrack.apply(this, args);
          };
          
          const originalAddTransceiver = pc.addTransceiver;
          pc.addTransceiver = function(...args) {
            window.logBot(`RTCPeerConnection.addTransceiver called`);
            return originalAddTransceiver.apply(this, args);
          };
          
          pc.addEventListener('track', (e) => {
            window.logBot(`Track event fired: ${e.track.kind}`);
            self.onTrackCallbacks.forEach(cb => cb(e, pc));
          });
          
          return pc;
        };
        
        // Copy static properties
        for (const prop in originalRTCPeerConnection) {
          if (!(prop in window.RTCPeerConnection)) {
            window.RTCPeerConnection[prop] = originalRTCPeerConnection[prop];
          }
        }
        
        window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
        window.RTCPeerConnection.prototype.constructor = window.RTCPeerConnection;
        
        window.logBot('RTCInterceptor: Installed RTCPeerConnection interceptor');
      }
    
      onTrack(callback) {
        this.onTrackCallbacks.push(callback);
      }
    
      getPeerConnections() {
        return Array.from(this.peerConnections);
      }
    }
    
    // Define RTCRtpReceiverInterceptor class inside the evaluate function
    class RTCRtpReceiverInterceptor {
      constructor() {
        this.receivers = new Map();
      }
      
      install() {
        const originalGetContributingSources = RTCRtpReceiver.prototype.getContributingSources;
        const self = this;
        
        RTCRtpReceiver.prototype.getContributingSources = function() {
          const sources = originalGetContributingSources.call(this);
          if (sources && sources.length > 0) {
            self.receivers.set(this, sources);
          }
          return sources;
        };
        
        window.logBot('RTCRtpReceiverInterceptor: Installed RTCRtpReceiver interceptor');
      }
      
      getReceivers() {
        return Array.from(this.receivers.keys());
      }
    }
    
    // Initialize RTC interceptors
    window.rtcInterceptor = new RTCInterceptor();
    window.rtcInterceptor.install();
    
    window.rtpReceiverInterceptor = new RTCRtpReceiverInterceptor();
    window.rtpReceiverInterceptor.install();
    
    // Define UserManager class inside the evaluate function
    class UserManager {
      constructor() {
        this.users = new Map(); // participantId -> {displayName, deviceId, streamId}
        this.streamToParticipant = new Map(); // streamId -> participantId
      }
      
      addUser(participantId, displayName) {
        if (!this.users.has(participantId)) {
          this.users.set(participantId, {
            participantId,
            displayName: displayName || 'Unknown',
            streamIds: new Set(),
            joinTime: new Date().toISOString()
          });
          window.logBot(`User added: ${displayName} (${participantId})`);
          
          // Update meeting metadata when adding new participant
           try {
             window.updateMeetingParticipants({
               participant_id: participantId,
               display_name: displayName || 'Unknown',
               join_time: new Date().toISOString()
             });
           } catch (e) {
             window.logBot(`Error updating meeting metadata: ${e.message}`);
           }
        }
        return this.users.get(participantId);
      }
      
      getUser(participantId) {
        return this.users.get(participantId);
      }
      
      associateStream(participantId, streamId) {
        if (!streamId) return;
        
        const user = this.users.get(participantId);
        if (user) {
          user.streamIds.add(streamId);
          this.streamToParticipant.set(streamId, participantId);
          window.logBot(`Stream ${streamId} associated with user ${user.displayName}`);
        }
      }
      
      getParticipantByStreamId(streamId) {
        const participantId = this.streamToParticipant.get(streamId);
        if (participantId) {
          return this.users.get(participantId);
        }
        return null;
      }
      
      getFirstParticipant() {
        // Return the first participant that is not 'You' or 'Unknown'
        for (const user of this.users.values()) {
          if (user.displayName && user.displayName !== 'You' && user.displayName !== 'Unknown') {
            return user;
          }
        }
        
        // If no suitable participant found, return the first one
        if (this.users.size > 0) {
          return this.users.values().next().value;
        }
        return null;
      }
      
      // Extract participant info from Google Meet DOM
      async extractParticipantsFromDOM() {
        try {
          // Wait for participants list to be available
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Find all participant elements - try multiple selectors
          let participantElements = document.querySelectorAll('[data-participant-id]');
          
          // If no elements found with data-participant-id, try alternative selectors
          if (participantElements.length === 0) {
            // Try to find participants panel first
            const participantsPanel = document.querySelector('[aria-label="Participants"]') || 
                                     document.querySelector('[aria-label="Người tham gia"]') ||
                                     document.querySelector('[aria-label="参加者"]');
            
            if (participantsPanel) {
              // Try to click it to open the panel if needed
              try { participantsPanel.click(); } catch (e) {}
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
            
            // Try alternative selectors for participant elements
            participantElements = document.querySelectorAll('.ZjFb7c') || // Name elements
                                document.querySelectorAll('.VfPpkd-gIZYDc') || // Participant rows
                                document.querySelectorAll('.KV1GEc'); // Another possible container
          }
          
          if (participantElements.length === 0) {
            // If still no elements found, try to extract from the video elements
            const videoElements = document.querySelectorAll('video');
            if (videoElements.length > 0) {
              window.logBot(`No participant elements found in DOM, but found ${videoElements.length} video elements`);
              
              // Create synthetic participants based on video elements
              for (let i = 0; i < videoElements.length; i++) {
                const syntheticId = `synthetic_${i}_${Date.now()}`;
                this.addUser(syntheticId, `Participant ${i+1}`);
              }
              
              window.logBot(`Created ${videoElements.length} synthetic participants`);
              return;
            }
          }
          
          if (participantElements.length === 0) {
            window.logBot('No participant elements found in DOM with any selector');
            
            // Create at least one synthetic participant for the mixed audio
            const syntheticId = `synthetic_mixed_${Date.now()}`;
            this.addUser(syntheticId, 'Mixed Audio');
            window.logBot('Created synthetic participant for mixed audio');
            return;
          }
          
          // Process found participant elements
          window.logBot(`Found ${participantElements.length} participant elements in DOM`);
          
          for (const elem of participantElements) {
            let participantId = elem.getAttribute('data-participant-id');
            let displayName = '';
            
            // Try to find display name in different ways
            const nameElem = elem.querySelector('.ZjFb7c') || // Standard name element
                           elem.querySelector('.jKwXVe') ||  // Another possible name class
                           elem.querySelector('span[jsname="YPqjbf"]'); // jsname attribute
            
            if (nameElem) {
              displayName = nameElem.textContent.trim();
            } else {
              // If no specific name element found, use the element's text content
              displayName = elem.textContent.trim();
            }
            
            // If no participant ID found, generate one
            if (!participantId) {
              participantId = `dom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            }
            
            // Add user to manager
            this.addUser(participantId, displayName);
          }
          
          window.logBot(`Extracted ${this.users.size} participants from DOM`);
        } catch (error) {
          window.logBot(`Error extracting participants from DOM: ${error.message}`);
        }
      }
    }
    
    // Define ReceiverManager class inside the evaluate function
    class ReceiverManager {
      constructor() {
        this.receivers = new Map(); // receiverId -> {track, streamId}
        this.streamToReceiver = new Map(); // streamId -> receiverId
        this.sourceToStream = new Map(); // sourceId -> streamId
      }
      
      addReceiver(receiver, track, streamId) {
        const receiverId = this.getReceiverId(receiver);
        
        this.receivers.set(receiverId, {
          receiver,
          track,
          streamId
        });
        
        if (streamId) {
          this.streamToReceiver.set(streamId, receiverId);
          window.logBot(`ReceiverManager: Added receiver for stream ${streamId}`);
        }
        
        return receiverId;
      }
      
      getReceiverId(receiver) {
        return receiver._id || `receiver_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      }
      
      mapSourceToStream(sourceId, streamId) {
        this.sourceToStream.set(sourceId, streamId);
        window.logBot(`ReceiverManager: Mapped source ${sourceId} to stream ${streamId}`);
      }
      
      getStreamIdBySourceId(sourceId) {
        return this.sourceToStream.get(sourceId);
      }
      
      getReceiverByStreamId(streamId) {
        const receiverId = this.streamToReceiver.get(streamId);
        if (receiverId) {
          return this.receivers.get(receiverId);
        }
        return null;
      }
    }
    
    // Initialize managers
    window.userManager = new UserManager();
    window.receiverManager = new ReceiverManager();
    
    // Set up track handling
    window.rtcInterceptor.onTrack((event, pc) => {
      try {
        const { track, streams } = event;
        if (track.kind !== 'audio') return;
        
        window.logBot(`Audio track detected: ${track.id}`);
        
        // Try to find participant for this track
        let participantId = null;
        let displayName = null;
        
        // Extract participant info from DOM
        window.userManager.extractParticipantsFromDOM().then(() => {
          // Set up MediaStreamTrackProcessor for this track
          if ('MediaStreamTrackProcessor' in window) {
            window.logBot(`Setting up MediaStreamTrackProcessor for track ${track.id}`);
            
            const processor = new MediaStreamTrackProcessor({ track });
            const readable = processor.readable;
            const writable = new WritableStream();
            
            // Create transform stream for audio processing
            const transformStream = new TransformStream({
              async transform(frame, controller) {
                try {
                  // Get audio data
                  const buffer = new Float32Array(frame.numberOfFrames * frame.numberOfChannels);
                  frame.copyTo(buffer);
                  
                  // Convert to mono if needed
                  const monoData = convertToMono(buffer, frame.numberOfChannels);
                  
                  // Check if audio has signal or is silent
                  const maxAmplitude = calculateMaxAmplitude(monoData);
                  const isSilent = maxAmplitude < SILENCE_THRESHOLD;
                  
                  if (isSilent) {
                    window.logBot(`Silent frame detected for track ${track.id}`);
                    frame.close();
                    return;
                  }
                  
                  // Convert to int16 for saving
                  const i16 = convertFloat32ToInt16(monoData);
                  
                  // Try to find participant for this track
                  const streamId = streams[0]?.id || track.id;
                  const participant = window.userManager.getParticipantByStreamId(streamId);
                  
                  if (participant) {
                    participantId = participant.participantId;
                    displayName = participant.displayName;
                    window.logBot(`Found participant for track: ${displayName} (${participantId})`);
                  } else {
                    // If we can't find participant, use first available or generate ID
                    const firstParticipant = window.userManager.getFirstParticipant();
                    if (firstParticipant) {
                      participantId = firstParticipant.participantId;
                      displayName = firstParticipant.displayName;
                      window.logBot(`Using first participant for track: ${displayName} (${participantId})`);
                    } else {
                      participantId = `unknown_${Date.now()}`;
                      displayName = 'Unknown Participant';
                      window.logBot(`Using generated ID for track: ${participantId}`);
                    }
                    
                    // Associate stream with participant
                    window.userManager.associateStream(participantId, streamId);
                  }
                  
                  // Send audio chunk to Node.js
                  await window.sendParticipantAudioChunk(participantId, displayName, Array.from(i16));
                  
                  // Pass through the frame
                  controller.enqueue(frame);
                } catch (error) {
                  window.logBot(`Error processing audio frame: ${error.message}`);
                  frame.close();
                }
              },
              flush() {
                window.logBot('Audio transform stream flush called');
              }
            });
            
            // Connect the streams
            readable
              .pipeThrough(transformStream)
              .pipeTo(writable)
              .catch(error => {
                window.logBot(`Audio pipeline error: ${error.message}`);
              });
            
            window.logBot('Per-participant audio processor set up');
          } else {
            window.logBot('MediaStreamTrackProcessor not available in this browser');
          }
        }).catch(error => {
          window.logBot(`Error extracting participants: ${error.message}`);
        });
      } catch (error) {
        window.logBot(`Error setting up track processing: ${error.message}`);
      }
    });
    
    // ====== User Manager and ReceiverManager ====== (Moved inside page.evaluate)

// Initialize managers
    const userManager = new UserManager();
    const receiverManager = new ReceiverManager();
    
    // Extract initial participants
    await userManager.extractParticipantsFromDOM();
    
    // Set up periodic participant extraction
    setInterval(() => userManager.extractParticipantsFromDOM(), 10000);
    
    // Initialize RTC interceptors
    const rtpReceiverInterceptor = new RTCRtpReceiverInterceptor((receiver, result) => {
      receiverManager.updateContributingSources(receiver, result);
    });
    
    // Track audio streams and processors
    const audioTracks = [];
    const audioProcessors = [];
    
    // Set up mixed audio context (for backward compatibility)
    const mixedAudioContext = new AudioContext();
    const mixedDestination = mixedAudioContext.createMediaStreamDestination();
    const mixedProcessor = mixedAudioContext.createScriptProcessor(4096, 1, 1);
    const mixedSink = mixedAudioContext.createGain(); mixedSink.gain.value = 0;
    
    // Set up RTCPeerConnection interceptor
    new RTCInterceptor({
      onPeerConnectionCreate: (peerConnection) => {
        window.logBot('New RTCPeerConnection created');
        
        peerConnection.addEventListener('track', async (event) => {
          if (event.track.kind !== 'audio') return;
          
          window.logBot(`New audio track: ${event.track.id}`);
          audioTracks.push(event.track);
          
          // Connect to mixed audio (for backward compatibility)
          try {
            const stream = new MediaStream([event.track]);
            const source = mixedAudioContext.createMediaStreamSource(stream);
            source.connect(mixedDestination);
            window.logBot('Connected to mixed audio');
          } catch (e) {
            window.logBot(`Error connecting to mixed audio: ${e.message}`);
          }
          
          // Set up per-participant audio processing
          try {
            // Create processor for this track
            const processor = new MediaStreamTrackProcessor({ track: event.track });
            const generator = new MediaStreamTrackGenerator({ kind: 'audio' });
            
            // Get readable stream of audio frames
            const readable = processor.readable;
            const writable = generator.writable;
            
            // Get stream ID and try to associate with participant
            const streamId = event.streams[0]?.id;
            
            // Transform stream to process audio frames
            const transformStream = new TransformStream({
              async transform(frame, controller) {
                if (!frame) return;
                
                try {
                  // Extract audio data
                  const numChannels = frame.numberOfChannels;
                  const numSamples = frame.numberOfFrames;
                  const audioData = new Float32Array(numSamples);
                  
                  // Convert multi-channel to mono if needed
                  if (numChannels > 1) {
                    const channelData = new Float32Array(numSamples);
                    for (let channel = 0; channel < numChannels; channel++) {
                      frame.copyTo(channelData, { planeIndex: channel });
                      for (let i = 0; i < numSamples; i++) {
                        audioData[i] += channelData[i];
                      }
                    }
                    for (let i = 0; i < numSamples; i++) {
                      audioData[i] /= numChannels;
                    }
                  } else {
                    frame.copyTo(audioData, { planeIndex: 0 });
                  }
                  
                  // Skip silent frames but with much lower threshold
                  let maxAmplitude = 0;
                  for (let i = 0; i < audioData.length; i++) {
                    maxAmplitude = Math.max(maxAmplitude, Math.abs(audioData[i]));
                  }
                  
                  // Use an extremely low threshold to capture almost all audio
                  // Further reduced from 0.0005 to 0.0001 to capture very quiet audio
                  const isSilent = maxAmplitude < 0.0001;
                  
                  // Log amplitude for debugging
                  console.log(`[AUDIO_FRAME] Max amplitude: ${maxAmplitude.toFixed(6)}, isSilent: ${isSilent}`);
                  
                  if (isSilent) {
                    controller.enqueue(frame);
                    return;
                  }
                  
                  // Log audio level for debugging
                  window.logBot(`Audio frame max amplitude: ${maxAmplitude.toFixed(6)}`);
                  
                  // Get contributing sources for this receiver
                  const contributingSources = receiverManager.getContributingSources(event.receiver);
                  
                  // Find the loudest contributing source
                  let loudestSource = null;
                  let maxLevel = 0;
                  
                  // Log contributing sources for debugging
                  window.logBot(`Found ${contributingSources.length} contributing sources`);
                  
                  contributingSources.forEach(source => {
                    if (source && source.source) {
                      window.logBot(`Source: ${source.source} - Level: ${source.audioLevel || 'unknown'}`);
                      if (source.audioLevel && source.audioLevel > maxLevel) {
                        maxLevel = source.audioLevel;
                        loudestSource = source.source;
                      }
                    }
                  });
                  
                  // If no loudest source found but we have audio, use the first source
                  if (!loudestSource && contributingSources.length > 0 && contributingSources[0].source) {
                    loudestSource = contributingSources[0].source;
                    window.logBot(`Using first source as loudest: ${loudestSource}`);
                  }
                  
                  // Try to find participant for this audio
                  let participantId = null;
                  let displayName = null;
                  
                  // First try by contributing source
                  if (loudestSource) {
                    const sourceStreamId = receiverManager.getStreamIdForSource(loudestSource);
                    if (sourceStreamId) {
                      const participant = userManager.getParticipantByStreamId(sourceStreamId);
                      if (participant) {
                        participantId = participant.participantId;
                        displayName = participant.displayName;
                      }
                    }
                  }
                  
                  // If not found, try by stream ID
                  if (!participantId && streamId) {
                    const participant = userManager.getParticipantByStreamId(streamId);
                    if (participant) {
                      participantId = participant.participantId;
                      displayName = participant.displayName;
                      
                      // Associate this stream with the participant
                      userManager.associateStream(participantId, streamId);
                    }
                  }
                  
                  // If still not found, try to use any available participant
                  if (!participantId) {
                    // Get the first participant from userManager if available
                    const firstParticipant = userManager.getFirstParticipant();
                    if (firstParticipant) {
                      participantId = firstParticipant.participantId;
                      displayName = firstParticipant.displayName;
                      window.logBot(`Using first available participant: ${displayName} (${participantId})`);
                      
                      // Associate this stream with the participant
                      if (streamId) {
                        userManager.associateStream(participantId, streamId);
                      }
                    } else {
                      // Create a synthetic ID based on track as last resort
                      participantId = `unknown_${event.track.id}`;
                      displayName = 'Unknown Speaker';
                      
                      // Add this unknown participant to the user manager
                      userManager.addUser(participantId, displayName);
                      
                      // Associate this stream with the participant
                      if (streamId) {
                        userManager.associateStream(participantId, streamId);
                      }
                    }
                  }
                  
                  // Log audio activity for debugging
                  window.logBot(`Audio activity from: ${displayName} (${participantId}) - level: ${maxAmplitude.toFixed(4)}`);
                  
                  
                  // Convert to int16 and send
                  const i16 = f32ToI16LEBytes(audioData);
                  window.logBot(`Sending audio chunk for participant: ${displayName} (${participantId}) - size: ${i16.length} bytes`);
                  
                  // Force log to console to ensure visibility
                  console.log(`[AUDIO_DEBUG] Sending chunk for ${displayName} (${participantId}) - size: ${i16.length} bytes`);
                  
                  // Check if the audio data is valid
                  let hasSignal = false;
                  for (let i = 0; i < i16.length; i += 2) {
                    const sample = (i16[i+1] << 8) | i16[i];
                    if (Math.abs(sample) > 100) { // Check if there's any non-silent audio
                      hasSignal = true;
                      break;
                    }
                  }
                  
                  if (hasSignal) {
                    window.logBot(`Audio chunk has signal - sending for ${participantId}`);
                    console.log(`[AUDIO_DEBUG] Audio chunk has signal - sending for ${participantId}`);
                  } else {
                    window.logBot(`Audio chunk is silent - skipping for ${participantId}`);
                    console.log(`[AUDIO_DEBUG] Audio chunk is silent - skipping for ${participantId}`);
                  }
                  
                  await window.sendParticipantAudioChunk(participantId, displayName, Array.from(i16));
                  
                  // Pass through the original frame
                  controller.enqueue(frame);
                } catch (error) {
                  window.logBot(`Error processing audio frame: ${error.message}`);
                  frame.close();
                }
              },
              flush() {
                window.logBot('Audio transform stream flush called');
              }
            });
            
            // Connect the streams
            readable
              .pipeThrough(transformStream)
              .pipeTo(writable)
              .catch(error => {
                window.logBot(`Audio pipeline error: ${error.message}`);
              });
            
            audioProcessors.push({ processor, generator, transformStream });
            window.logBot('Per-participant audio processor set up');
          } catch (e) {
            window.logBot(`Error setting up per-participant audio: ${e.message}`);
          }
        });
      }
    });
    
    // Set up mixed audio processing (for backward compatibility)
    const mixedSource = mixedAudioContext.createMediaStreamSource(mixedDestination.stream);
    mixedSource.connect(mixedProcessor);
    mixedProcessor.connect(mixedSink);
    mixedSink.connect(mixedAudioContext.destination);
    
    window.logBot(`Mixed AudioContext sampleRate: ${mixedAudioContext.sampleRate}`);
    const ratio = SAMPLE_RATE_OUT / mixedAudioContext.sampleRate;
    
    let running = true;
    const stopAt = Date.now() + seconds * 1000;
    
    // Process mixed audio
    mixedProcessor.onaudioprocess = async (ev) => {
      if (!running) return;
      
      const inF32 = ev.inputBuffer.getChannelData(0);
      const outLen = Math.max(1, Math.round(inF32.length * ratio));
      const outF32 = new Float32Array(outLen);
      
      // Resample if needed
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
      
      // Check if there's any audio signal
      let maxAmplitude = 0;
      for (let i = 0; i < outF32.length; i++) {
        maxAmplitude = Math.max(maxAmplitude, Math.abs(outF32[i]));
      }
      
      // Log audio level for debugging
      if (maxAmplitude > 0.0001) {
        window.logBot(`Mixed audio frame max amplitude: ${maxAmplitude.toFixed(6)}`);
      }
      
      try {
        const i16 = f32ToI16LEBytes(outF32);
        await window.sendMixedAudioChunk(Array.from(i16));
      } catch (e) {
        window.logBot(`sendMixedAudioChunk error: ${e.message}`);
      }
      
      // Check if recording time is up
      if (Date.now() >= stopAt) {
        running = false;
        try {
          mixedProcessor.disconnect();
          window.logBot('Audio capture stopping...');
          await window.closeAudioFiles();
        } catch (e) {
          window.logBot(`closeAudioFiles error: ${e.message}`);
        }
      }
    };
    
    window.logBot('RTC audio capture started.');
  }, recordSeconds);
}

// ====== Main flow ======
async function recordGoogleMeet(meetingUrl, botName, recordSeconds = RECORD_SECONDS_DEFAULT) {
  log('Launch browser...');
  const browser = await chromium.launch({
    headless: false,
    args: [
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
  
  // Define global UserManager and ReceiverManager classes
  class UserManager {
    constructor() {
      this.users = new Map(); // Map<participantId, {displayName, streamIds}>
      this.streamToParticipant = new Map(); // Map<streamId, participantId>
    }

    addUser(participantId, displayName) {
      if (!this.users.has(participantId)) {
        this.users.set(participantId, {
          displayName: displayName || 'Unknown User',
          streamIds: new Set()
        });
        log(`UserManager: Added user ${displayName} (${participantId})`);
      }
      return this.users.get(participantId);
    }

    getUser(participantId) {
      return this.users.get(participantId);
    }

    getUserByStreamId(streamId) {
      const participantId = this.streamToParticipant.get(streamId);
      if (participantId) {
        return this.getUser(participantId);
      }
      return null;
    }

    associateStreamWithParticipant(streamId, participantId) {
      this.streamToParticipant.set(streamId, participantId);
      const user = this.users.get(participantId);
      if (user) {
        user.streamIds.add(streamId);
        log(`UserManager: Associated stream ${streamId} with user ${user.displayName} (${participantId})`);
      }
    }

    getFirstParticipant() {
      const firstEntry = this.users.entries().next().value;
      return firstEntry ? { participantId: firstEntry[0], ...firstEntry[1] } : null;
    }

    getAllParticipants() {
      return Array.from(this.users.entries()).map(([participantId, data]) => ({
        participantId,
        ...data
      }));
    }
  }

  class ReceiverManager {
    constructor() {
      this.receivers = new Map(); // Map<receiverId, {track, streamId}>
      this.streamToReceiver = new Map(); // Map<streamId, receiverId>
    }

    addReceiver(receiver, track) {
      const receiverId = this.getReceiverId(receiver);
      const streamId = track.id;
      
      this.receivers.set(receiverId, {
        receiver,
        track,
        streamId
      });
      
      this.streamToReceiver.set(streamId, receiverId);
      log(`ReceiverManager: Added receiver for stream ${streamId}`);
      return receiverId;
    }

    getReceiverId(receiver) {
      return receiver._id || `receiver_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    getReceiverByStreamId(streamId) {
      const receiverId = this.streamToReceiver.get(streamId);
      if (receiverId) {
        return this.receivers.get(receiverId);
      }
      return null;
    }

    getAllReceivers() {
      return Array.from(this.receivers.values());
    }
  }
  
  // Initialize global managers
  userManager = new UserManager();
  receiverManager = new ReceiverManager();

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
    
    // Set up initialData for audio processing
    window.initialData = window.initialData || {};
    window.initialData.sendPerParticipantAudio = true;
  });

    log('Join meeting...');
    await joinMeeting(page, meetingUrl, botName);

    log('Wait admission...');
    await waitForMeetingAdmission(page, 300000); // 5 mins

    log('Wait UI stabilize...');
    await page.waitForTimeout(8000);

    // Extract meeting ID from URL
    const meetingId = new URL(page.url()).pathname.split('/').pop() || 'unknown';
    log(`Meeting ID: ${meetingId}`);

    log(`Recording audio for ${recordSeconds}s`);
    await startRTCAudioRecording(page, recordSeconds, meetingId);

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