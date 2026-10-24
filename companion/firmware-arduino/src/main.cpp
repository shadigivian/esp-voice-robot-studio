#include "Button.h"
#include "FactoryReset.h"
#include "LEDHandler.h"
#include "OTA.h"
#include "WifiManager.h"
#include <driver/touch_sensor.h>
#ifdef BOARD_HAS_PSRAM
#include <esp_heap_caps.h>
#endif
#ifdef ELATO_USB_WIFI_SETUP
#include "UsbWifiSetup.h"
#endif
#ifdef ELATO_MANAGEMENT
#include "ManagementProtocol.h"
// Supply this renderer in a board-specific .cpp after identifying the OLED.
extern void managementRenderPairingCode(const String &, const String &) __attribute__((weak));
static ManagementProtocol managementProtocol;
static String managedVoiceHost, managedVoiceToken;
static int managedVoicePort = 443;

bool managementVoiceEndpoint(String &host, int &port, String &path, String &token) {
  if (managedVoiceToken.isEmpty() || managedVoiceHost.isEmpty()) return false;
  host = managedVoiceHost; port = managedVoicePort; token = managedVoiceToken;
  path = "/managed-voice";
  return true;
}

const char *managementTrustedRootCa() {
  return managementProtocol.trustedRootCa();
}

bool readUsbManagementPairingCode(String &code, String &expiresAt) {
  return managementProtocol.pairingCode(code, expiresAt);
}

static const char *managementConversation() {
  switch (deviceState) {
    case LISTENING: return "listening";
    case SPEAKING: return "speaking";
    case PROCESSING: case WAITING: return "processing";
    default: return "idle";
  }
}

static void managementCredentials(const String &token, const String &host, uint16_t port) {
  if (shutdownInProgress) return;
  xSemaphoreTake(wsMutex, portMAX_DELAY);
  webSocket.clearRelay(); // The legacy relay pins its original hosted server.
  managedVoiceToken = token; managedVoiceHost = host; managedVoicePort = port;
  clearVoicePlayback();
  xSemaphoreGive(wsMutex);
  websocketSetup(host, port, "/managed-voice");
}

static void managementRevoked() {
  xSemaphoreTake(wsMutex, portMAX_DELAY);
  managedVoiceToken = "";
  webSocket.disconnect();
  clearVoicePlayback();
  xSemaphoreGive(wsMutex);
}

static bool managementApply(const String &type, JsonVariantConst payload, String &error) {
  if (shutdownInProgress) { error = "device_stopping"; return false; }
  if (type == "volume" && payload["value"].is<int>()) {
    int value = payload["value"].as<int>();
    if (value < 0 || value > 100) { error = "invalid_volume"; return false; }
    currentVolume = value;
    volume.setVolume(value / 100.0f); volumePitch.setVolume(value / 100.0f);
    return true;
  }
  if (type == "config" && payload["configVersion"].is<unsigned int>()) {
    // Prompts/sources are server-side. Persist the received pointer for the next
    // interaction; the active provider session deliberately keeps its snapshot.
    Preferences store;
    if (!store.begin("robot-mgmt", false)) { error = "storage_unavailable"; return false; }
    const uint32_t version = payload["configVersion"].as<uint32_t>();
    const bool applied = store.putUInt("version", version) == sizeof(uint32_t);
    store.end();
    if (!applied) error = "storage_unavailable";
    return applied;
  }
  error = "unsupported_firmware_command";
  return false;
}

static void setupManagement() {
  configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
  ManagementProtocol::Hooks hooks;
  hooks.displayCode = managementRenderPairingCode;
  hooks.apply = managementApply;
  hooks.credentials = managementCredentials;
  hooks.revoked = managementRevoked;
  hooks.conversation = managementConversation;
  // A code is returned only after an explicit command on the local USB cable.
  // Unknown OLED controllers stay uninitialized; GPIO8/9 remain reserved for I2C.
  hooks.usbPairing = true;
  managementProtocol.begin(CA_cert, hooks);
}
#endif

#define TOUCH_THRESHOLD 28000
#define REQUIRED_RELEASE_CHECKS                                                \
  100 // how many consecutive times we need "below threshold" to confirm release
#define TOUCH_DEBOUNCE_DELAY 500 // milliseconds

AsyncWebServer webServer(80);
WIFIMANAGER WifiManager;
esp_err_t getErr = ESP_OK;

// Main Thread -> onButtonLongPressUpEventCb -> enterSleep()
// Main Thread -> onButtonDoubleClickCb -> enterSleep()
// Touch Task -> touchTask -> enterSleep()
// Main Thread -> loop() (inactivity timeout) -> enterSleep()
void enterSleep() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  Serial.println("Going to sleep...");

  // First, change device state to prevent any new data processing
  deviceState = SLEEP;
  scheduleListeningRestart = false;
  setAmplifierEnabled(false); // Fixed-high SD boards mute through the DMA flush below.
  i2sOutputFlushScheduled = true;
  i2sInputFlushScheduled = true;
  vTaskDelay(10); // let all tasks accept state

  xSemaphoreTake(wsMutex, portMAX_DELAY);

  // Stop audio tasks first
  i2s_stop(I2S_PORT_IN);
  i2s_stop(I2S_PORT_OUT);

  // Properly disconnect WebSocket and wait for it to complete
  if (webSocket.isConnected()) {
    webSocket.disconnect();
    // Give some time for the disconnect to process
  }
  xSemaphoreGive(wsMutex);
  delay(100);

  // Deep sleep resets the drivers. Do not free them here while another task
  // may still be returning from an in-flight I2S read/write.

  // Flush any remaining serial output
  Serial.flush();

#ifdef TOUCH_MODE
  touch_pad_intr_disable(TOUCH_PAD_INTR_MASK_ALL);
  while (touchRead(TOUCH_PAD_NUM2) > TOUCH_THRESHOLD) {
    delay(50);
  }
  delay(500);
  touchSleepWakeUpEnable(TOUCH_PAD_NUM2, TOUCH_THRESHOLD);
#elif defined(DIGITAL_TOUCH_MODE)
  // A momentary module must be released before arming its active-HIGH wakeup.
  while (digitalRead(BUTTON_PIN) == HIGH) {
    delay(20);
  }
  esp_sleep_enable_ext0_wakeup(BUTTON_PIN, HIGH);
#endif

  esp_deep_sleep_start();
  delay(1000);
}

void processSleepRequest() {
  if (sleepRequested) {
    sleepRequested = false;
    enterSleep(); // Just call it directly - no state checking needed
  }
}

void printOutESP32Error(esp_err_t err) {
  switch (err) {
  case ESP_OK:
    Serial.println("ESP_OK no errors");
    break;
  case ESP_ERR_INVALID_ARG:
    Serial.println("ESP_ERR_INVALID_ARG if the selected GPIO is not an RTC "
                   "GPIO, or the mode is invalid");
    break;
  case ESP_ERR_INVALID_STATE:
    Serial.println("ESP_ERR_INVALID_STATE if wakeup triggers conflict or "
                   "wireless not stopped");
    break;
  default:
    Serial.printf("Unknown error code: %d\n", err);
    break;
  }
}

static void onButtonLongPressUpEventCb(void *button_handle, void *usr_data) {
  Serial.println("Button long press end");
  delay(10);
  sleepRequested = true;
}

static void onButtonDoubleClickCb(void *button_handle, void *usr_data) {
  Serial.println("Button double click");
  delay(10);
  sleepRequested = true;
}

void getAuthTokenFromNVS() {
  preferences.begin("auth", false);
  authTokenGlobal = preferences.getString("auth_token", "");
  preferences.end();
}

void setupWiFi() {
  WifiManager.startBackgroundTask(
      "ELATO-DEVICE"); // Run the background task to take care of our Wifi
  WifiManager.fallbackToSoftAp(
      true); // Run a SoftAP if no known AP can be reached
  WifiManager.attachWebServer(&webServer); // Attach our API to the Webserver
  WifiManager.attachUI();                  // Attach the UI to the Webserver

  // Run the Webserver and add your webpages to it
  webServer.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    request->redirect("/wifi");
  });
  webServer.onNotFound([](AsyncWebServerRequest *request) {
    request->send(404, "text/plain", "Not found");
  });
  webServer.begin();
}

void touchTask(void *parameter) {
  touch_pad_init();
  touch_pad_config(TOUCH_PAD_NUM2);

  bool touched = false;
  unsigned long pressStartTime = 0;
  unsigned long lastTouchTime = 0;
  const unsigned long LONG_PRESS_DURATION = 500; // 500ms for long press

  while (1) {
    // Read the touch sensor
    uint32_t touchValue = touchRead(TOUCH_PAD_NUM2);
    bool isTouched = (touchValue > TOUCH_THRESHOLD);
    unsigned long currentTime = millis();

    // Initial touch detection
    if (isTouched && !touched &&
        (currentTime - lastTouchTime > TOUCH_DEBOUNCE_DELAY)) {
      touched = true;
      pressStartTime = currentTime; // Start timing the press
      lastTouchTime = currentTime;
    }

    // Check for long press while touched
    if (touched && isTouched) {
      if (currentTime - pressStartTime >= LONG_PRESS_DURATION) {
        sleepRequested =
            true; // Only enter sleep after 500ms of continuous touch
      }
    }

    // Release detection
    if (!isTouched && touched) {
      touched = false;
      pressStartTime = 0; // Reset the press timer
    }

    vTaskDelay(20); // Reduced from 50ms to 20ms for better responsiveness
  }
  vTaskDelete(NULL);
}

void setupDeviceMetadata() {
  // factoryResetDevice();
  // resetAuth();

  deviceState = IDLE;

  getAuthTokenFromNVS();
#ifndef ELATO_MANAGEMENT
  // A previous hosted OTA marker must not block provisioning a managed board.
  getOTAStatusFromNVS();
#endif

  if (otaState == OTA_IN_PROGRESS || otaState == OTA_COMPLETE) {
    deviceState = OTA;
  }
  if (factory_reset_status) {
    deviceState = FACTORY_RESET;
  }
}

void setup() {
#ifdef ELATO_USB_WIFI_SETUP
  Serial.setRxBufferSize(1024);
#endif
  Serial.begin(115200);
  delay(500);

#ifdef BOARD_HAS_PSRAM
  // Test only a block owned by this allocation; never overwrite the RAM heap.
  uint32_t *psramBlock = static_cast<uint32_t *>(
      heap_caps_malloc(1024, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  // The reported usable heap excludes allocator metadata from the 8 MiB chip.
  bool psramVerified = ESP.getPsramSize() >= 7U * 1024U * 1024U && psramBlock;
  if (psramBlock) {
    volatile uint32_t *probe = psramBlock;
    for (size_t i = 0; i < 256; ++i) probe[i] = 0xA5C30000U ^ i;
    for (size_t i = 0; i < 256; ++i)
      if (probe[i] != (0xA5C30000U ^ i)) psramVerified = false;
    heap_caps_free(psramBlock);
  }
  Serial.printf("[PSRAM] size=%u free=%u allocation_check=%s\n",
                ESP.getPsramSize(), ESP.getFreePsram(),
                psramVerified ? "OK" : "FAILED");
#endif

  // SETUP
  setupDeviceMetadata();
  wsMutex = xSemaphoreCreateMutex();
#ifdef ELATO_USB_WIFI_SETUP
  loadUsbRelayConfiguration();
#endif

// INTERRUPT
#ifdef TOUCH_MODE
  xTaskCreate(touchTask, "Touch Task", 4096, NULL, configMAX_PRIORITIES - 2,
              NULL);
#else
#ifdef DIGITAL_TOUCH_MODE
  Button *btn = new Button(BUTTON_PIN, true);
#else
  getErr = esp_sleep_enable_ext0_wakeup(BUTTON_PIN, LOW);
  printOutESP32Error(getErr);
  Button *btn = new Button(BUTTON_PIN, false);
#endif
  btn->attachLongPressUpEventCb(&onButtonLongPressUpEventCb, NULL);
  btn->attachDoubleClickEventCb(&onButtonDoubleClickCb, NULL);
#endif

  // Pin audio tasks to Core 1 (application core)
#ifndef ELATO_DISABLE_RGB_LED
  xTaskCreatePinnedToCore(ledTask,    // Function
                          "LED Task", // Name
                          4096,       // Stack size
                          NULL,       // Parameters
                          5,          // Priority
                          NULL,       // Handle
                          1           // Core 1 (application core)
  );
#endif

  xTaskCreatePinnedToCore(audioStreamTask, // Function
                          "Speaker Task",  // Name
                          4096,            // Stack size
                          NULL,            // Parameters
                          3,               // Priority
                          NULL,            // Handle
                          1                // Core 1 (application core)
  );

  xTaskCreatePinnedToCore(micTask,           // Function
                          "Microphone Task", // Name
                          4096,              // Stack size
                          NULL,              // Parameters
                          4,                 // Priority
                          NULL,              // Handle
                          1                  // Core 1 (application core)
  );

  // Pin network task to Core 0 (protocol core)
  xTaskCreatePinnedToCore(networkTask,              // Function
                          "Websocket Task",         // Name
                          8192,                     // Stack size
                          NULL,                     // Parameters
                          configMAX_PRIORITIES - 1, // Highest priority
                          &networkTaskHandle,       // Handle
                          0                         // Core 0 (protocol core)
  );

  // WIFI
  setupWiFi();
#ifdef ELATO_MANAGEMENT
  setupManagement();
#endif
}

void loop() {
#ifdef ELATO_USB_WIFI_SETUP
  processUsbWifiSetup();
#endif
#ifdef ELATO_DIAGNOSTICS
  static unsigned long lastHeapReport = 0;
  if (millis() - lastHeapReport >= 5000) {
    lastHeapReport = millis();
    Serial.printf("[HEAP] free=%u largest=%u minimum=%u psram_free=%u state=%d\n",
                  ESP.getFreeHeap(), ESP.getMaxAllocHeap(), ESP.getMinFreeHeap(),
                  ESP.getFreePsram(),
                  static_cast<int>(deviceState));
    reportAudioDiagnostics();
  }
#endif
  processSleepRequest();
  if (otaState == OTA_IN_PROGRESS) {
    loopOTA();
  }
}
