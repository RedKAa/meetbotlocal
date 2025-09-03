import { Page } from "playwright";
import { log, randomDelay } from "./utils";
import { BotConfig } from "./types";
import * as fs from "fs";
import * as path from "path";
import { convertRawToWav } from "./audio-utils";

// Ensure the output directory exists
const OUTPUT_DIR = path.join(__dirname, "recordings");
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

export async function handleLocalGoogleMeetTest(
  botConfig: BotConfig,
  page: Page
): Promise<void> {

  if (!botConfig.meetingUrl) {
    log("Error: Meeting URL is required for Google Meet but is null.");
    return;
  }

  log("Joining Google Meet for local test");
  try {
    await joinMeeting(page, botConfig.meetingUrl, botConfig.botName);
  } catch (error: any) {
    log("Error during joinMeeting: " + error.message);
    return;
  }

  log("Waiting for meeting admission");
  try {
    await waitForMeetingAdmission(
      page,
      botConfig.automaticLeave.waitingRoomTimeout
    );
  } catch (error: any) {
    log("Meeting admission failed: " + error.message);
    return;
  }

  log("Successfully admitted to the meeting, starting local recording");
  await startLocalRecording(page, botConfig);
}

const waitForMeetingAdmission = async (
  page: Page,
  timeout: number
): Promise<void> => {
  // Multiple selectors for leave button to handle different languages
  const leaveButtonSelectors = [
    '//button[@aria-label="Leave call"]',        // English
    '//button[@aria-label="Rời khỏi cuộc gọi"]', // Vietnamese
    '//button[@aria-label="Quitter l\'appel"]',  // French
    '//button[@aria-label="Verlassen"]',         // German
    '//button[@aria-label="Salir de la llamada"]', // Spanish
    '//button[@aria-label="通話を終了"]',          // Japanese
    '//button[@aria-label="통화 종료"]',           // Korean
    '//button[@aria-label="Покинуть вызов"]',    // Russian
    '//button[@aria-label="ออกจากสาย"]',          // Thai
    '//button[@aria-label="离开通话"]',            // Chinese
    '[aria-label*="Leave"]',                     // Generic
    '[aria-label*="Rời khỏi"]',                  // Vietnamese generic
    '[aria-label*="Quitter"]',                   // French generic
    '[aria-label*="Verlassen"]'                  // German generic
  ];

  // Try each selector until one is found
  for (const selector of leaveButtonSelectors) {
    try {
      log(`Waiting for meeting admission - looking for leave button: ${selector}`);
      await page.waitForSelector(selector, { timeout: timeout / leaveButtonSelectors.length });
      log("Successfully admitted to the meeting");
      return;
    } catch (e) {
      log(`Leave button not found with selector: ${selector}`);
    }
  }

  throw new Error(
    "Bot was not admitted into the meeting within the timeout period - leave button not found with any selector"
  );
};

const joinMeeting = async (page: Page, meetingUrl: string, botName: string) => {
  const enterNameField = 'input[type="text"][aria-label="Your name"]';
  // Multiple selectors for join button to handle different languages and versions
  const joinButtonSelectors = [
    '//button[.//span[text()="Join now"]]',     // English - Join now
    '//button[.//span[text()="Ask to join"]]',  // English - Ask to join
    '//button[.//span[text()="Tham gia ngay"]]', // Vietnamese - Join now
    '//button[.//span[text()="Tham gia"]]',      // Vietnamese - Join
    '//button[.//span[text()="Rejoindre"]]',     // French - Join
    '//button[.//span[text()="Beitreten"]]',     // German - Join
    '//button[.//span[text()="Participar ahora"]]', // Spanish - Join now
    '//button[.//span[text()="参加"]]',           // Japanese - Join
    '//button[.//span[text()="지금 참여"]]',        // Korean - Join now
    '//button[.//span[text()="Присоединиться"]]',  // Russian - Join
    '//button[.//span[text()="เข้าร่วม"]]',        // Thai - Join
    '//button[.//span[text()="现在加入"]]',         // Chinese - Join now
    '//button[.//span[contains(text(), "Join")]]',  // Generic - Any button containing "Join"
    '//button[.//span[contains(text(), "Tham gia")]]', // Generic - Any button containing "Tham gia"
    'button[data-mdc-dialog-action="join"]',       // Alternative selector
    '._3quh._30yy._2t_',
    '//button[contains(@class, "join-button")]'
  ];
  
  const muteButton = '[aria-label*="Turn off microphone"], [aria-label*="Tắt micrô"], [aria-label*="Mute"], [aria-label*="Stummschalten"]';
  const cameraOffButton = '[aria-label*="Turn off camera"], [aria-label*="Tắt camera"], [aria-label*="Video aus"], [aria-label*="カメラをオフ"]';

  await page.goto(meetingUrl, { waitUntil: "networkidle" });
  await page.bringToFront();

  // Add a longer, fixed wait after navigation for page elements to settle
  log("Waiting for page elements to settle after navigation...");
  await page.waitForTimeout(5000); // Wait 5 seconds

  // Enter name and join
  await page.waitForTimeout(randomDelay(1000));
  log("Attempting to find name input field...");
  // Increase timeout drastically
  await page.waitForSelector(enterNameField, { timeout: 120000 }); // 120 seconds
  log("Name input field found.");

  await page.waitForTimeout(randomDelay(1000));
  await page.fill(enterNameField, botName);

  // Mute mic and camera if available
  try {
    await page.waitForTimeout(randomDelay(500));
    await page.click(muteButton, { timeout: 200 });
    await page.waitForTimeout(200);
  } catch (e) {
    log("Microphone already muted or not found.");
  }
  try {
    await page.waitForTimeout(randomDelay(500));
    await page.click(cameraOffButton, { timeout: 200 });
    await page.waitForTimeout(200);
  } catch (e) {
    log("Camera already off or not found.");
  }

  // Try multiple selectors for join button
  let joinButtonFound = false;
  for (const selector of joinButtonSelectors) {
    try {
      log(`Trying to find join button with selector: ${selector}`);
      await page.waitForSelector(selector, { timeout: 10000 });
      await page.click(selector);
      log(`${botName} joined the Meeting using selector: ${selector}`);
      joinButtonFound = true;
      break;
    } catch (e) {
      log(`Join button not found with selector: ${selector}`);
    }
  }

  if (!joinButtonFound) {
    throw new Error("Could not find join button with any of the provided selectors");
  }
};

// Simplified recording function that saves audio to local files
const startLocalRecording = async (page: Page, botConfig: BotConfig) => {
  log("Starting local recording - saving audio to files");
  
  // Generate a unique filename for this recording
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `test.raw`;
  const filepath = path.join(OUTPUT_DIR, filename);
  
  log(`Recording will be saved to: ${filepath}`);
  
  // Create write stream for the audio data
  const writeStream = fs.createWriteStream(filepath);
  
  // Expose function to send audio data to Node.js
  await page.exposeFunction('sendAudioData', (base64Data: string) => {
    try {
      // Convert base64 back to binary and write to file
      const buffer = Buffer.from(base64Data, 'base64');
      writeStream.write(buffer);
    } catch (e: any) {
      log(`Error writing audio data to file: ${e.message}`);
    }
  });
  
  // Expose function to close the file when done
  await page.exposeFunction('closeRecordingFile', async () => {
    writeStream.end();
    log(`Recording saved to: ${filepath}`);
    
    // Convert RAW to WAV after recording
    try {
      const wavFilepath = filepath.replace('.raw', '.wav');
      await convertRawToWav(filepath, wavFilepath);
      log(`Converted recording to WAV: ${wavFilepath}`);
    } catch (error: any) {
      log(`Error converting recording to WAV: ${error.message}`);
    }
  });

  // Expose logging function for debugging
  await page.exposeFunction('logBot', (message: string) => {
    log(`[Browser] ${message}`);
  });

  // Define the browser-side recording function as a string to avoid TypeScript compilation issues
  const browserRecordingFunction = `
    async () => {
      window.logBot("Starting audio recording setup...");
      
      try {
        // Try to get display media (screen + audio) which should include meeting audio
        let stream;
        try {
          // Try to get display media with audio
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true
          });
          window.logBot("Successfully obtained display media stream with audio");
        } catch (getDisplayError) {
          window.logBot("Failed to get display media: " + getDisplayError.message);
          
          // Fallback to regular media devices
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: true,
              video: false
            });
            window.logBot("Successfully obtained user media stream with audio");
          } catch (getUserError) {
            window.logBot("Failed to get user media: " + getUserError.message);
            throw new Error("Could not obtain any audio stream");
          }
        }

        // Create audio context
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const audioContext = new AudioContext();
        
        // Resume audio context if suspended (required for some browsers)
        if (audioContext.state === 'suspended') {
          await audioContext.resume();
          window.logBot("Audio context resumed");
        }
        
        window.logBot("Audio context created successfully");

        // Create media stream source from the captured stream
        const mediaStream = audioContext.createMediaStreamSource(stream);
        window.logBot("Media stream source created");

        // Create script processor with larger buffer size
        const recorder = audioContext.createScriptProcessor(8192, 1, 1);

        // Variable to track if we've sent any data
        let dataSent = false;
        let chunksRecorded = 0;

        recorder.onaudioprocess = async (event) => {
          try {
            const inputData = event.inputBuffer.getChannelData(0);
            
            // Check if we have actual audio data (not all zeros)
            let hasAudio = false;
            for (let i = 0; i < inputData.length; i++) {
              if (inputData[i] !== 0) {
                hasAudio = true;
                break;
              }
            }
            
            if (hasAudio) {
              const data = new Float32Array(inputData);
              
              // Convert Float32Array to base64 for transfer
              // Using a more browser-compatible approach
              const uint8Array = new Uint8Array(data.buffer);
              let binaryString = '';
              for (let i = 0; i < uint8Array.length; i++) {
                binaryString += String.fromCharCode(uint8Array[i]);
              }
              const base64Data = btoa(binaryString);
              
              // Send to Node.js to write to file
              await window.sendAudioData(base64Data);
              dataSent = true;
              chunksRecorded++;
              
              if (chunksRecorded % 50 === 0) {
                window.logBot(\`Recorded \${chunksRecorded} chunks of audio data\`);
              }
            } else {
              // Log periodically if no audio data
              if (!dataSent && chunksRecorded === 0) {
                window.logBot("No active audio data detected in this chunk.");
              }
            }
          } catch (e) {
            window.logBot(\`Error processing audio data: \${e.message}\`);
          }
        };

        // Connect the audio processing pipeline
        mediaStream.connect(recorder);
        const gainNode = audioContext.createGain();
        gainNode.gain.value = 0; // Mute the output to prevent feedback
        recorder.connect(gainNode);
        gainNode.connect(audioContext.destination);

        window.logBot("Audio processing pipeline connected and saving data to file.");

        // Record for a fixed duration (e.g., 60 seconds) for testing
        setTimeout(async () => {
          try {
            recorder.disconnect();
            gainNode.disconnect();
            mediaStream.disconnect();
            
            if (!dataSent) {
              window.logBot("Warning: No audio data was sent during the recording session.");
            } else {
              window.logBot(\`Recording completed with \${chunksRecorded} chunks of audio data.\`);
            }
            
            await window.closeRecordingFile();
            window.logBot("Local recording completed and file closed.");
          } catch (e) {
            window.logBot(\`Error during recording cleanup: \${e.message}\`);
            await window.closeRecordingFile();
          }
        }, 10000); // Record for 60 seconds
      } catch (error) {
        window.logBot(\`Error setting up audio recording: \${error.message}\`);
        await window.closeRecordingFile();
      }
    }
  `;

  // Execute the browser-side recording function
  await page.evaluate(browserRecordingFunction);
};