import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { handleLocalGoogleMeetTest } from "./botlocal";
import { BotConfig } from "./types";

// Use Stealth Plugin to avoid detection
const stealthPlugin = StealthPlugin();
stealthPlugin.enabledEvasions.delete("iframe.contentWindow");
stealthPlugin.enabledEvasions.delete("media.codecs");
chromium.use(stealthPlugin);

async function runLocalTest() {
  // Simple configuration for the test
  const botConfig: BotConfig = {
    platform: "google_meet",
    meetingUrl: "https://meet.google.com/xxx-xxx-xxx",
    botName: "HopFast",
    // Default values for required fields (not used in local test)
    token: "local-test-token",
    connectionId: "local-test-connection",
    nativeMeetingId: "local-test-meeting",
    language: "en",
    task: "transcribe",
    botManagerCallbackUrl: "",
    container_name: "local-test",
    automaticLeave: {
      waitingRoomTimeout: 300000,
      noOneJoinedTimeout: 300000,
      everyoneLeftTimeout: 300000
    },
    redisUrl: "",
  };

  console.log("Starting local Google Meet test with config:", {
    meetingUrl: botConfig.meetingUrl,
    botName: botConfig.botName,
    platform: botConfig.platform
  });

  // Launch browser with stealth configuration
  const browser = await chromium.launch({
    headless: false, // Set to true for production
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--disable-accelerated-2d-canvas",
      "--no-zygote"
    ],
  });

  try {
    // Create a new page with permissions and viewport
    const context = await browser.newContext({
      permissions: ["camera", "microphone"],
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      viewport: {
        width: 1280,
        height: 720
      }
    });

    const page = await context.newPage();

    // Setup anti-detection measures
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", {
        get: () => [{ name: "Chrome PDF Plugin" }, { name: "Chrome PDF Viewer" }],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en"],
      });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 4 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
      Object.defineProperty(window, "innerWidth", { get: () => 1920 });
      Object.defineProperty(window, "innerHeight", { get: () => 1080 });
      Object.defineProperty(window, "outerWidth", { get: () => 1920 });
      Object.defineProperty(window, "outerHeight", { get: () => 1080 });
    });

    // Check if we want to run simple audio test or full Google Meet test
    const testType = process.env.TEST_TYPE || "meet"; // "meet" or "simple"
    
    if (testType === "simple") {
      console.log("Simple audio recorder is no longer available.");
      console.log("Running full Google Meet test instead...");
      // Run the local test
      await handleLocalGoogleMeetTest(botConfig, page);

      // Wait for recording to complete (60 seconds as defined in the script)
      console.log("Test running for 60 seconds...");
      await new Promise(resolve => setTimeout(resolve, 15000)); // Wait a bit longer than recording time
    } else {
      console.log("Running full Google Meet test...");
      // Run the local test
      await handleLocalGoogleMeetTest(botConfig, page);

      // Wait for recording to complete (60 seconds as defined in the script)
      console.log("Test running for 60 seconds...");
      await new Promise(resolve => setTimeout(resolve, 15000)); // Wait a bit longer than recording time
    }

    console.log("Test completed. Check the recordings folder for output files.");
  } catch (error) {
    console.error("Error during test:", error);
  } finally {
    await browser.close();
    console.log("Browser closed. Test finished.");
  }
}

// Run the test
runLocalTest().catch(console.error);