#pragma once

// Managed voice protocol. No OLED controller or pin mapping is assumed.
// Include once from main.cpp under ELATO_MANAGEMENT. Network work runs in its own task.
#ifdef ELATO_MANAGEMENT
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_system.h>
#include <time.h>

class ManagementProtocol {
public:
  using DisplayCode = void (*)(const String &, const String &);
  using ApplyCommand = bool (*)(const String &, JsonVariantConst, String &);
  using CredentialsChanged = void (*)(const String &, const String &, uint16_t);
  using AccessRevoked = void (*)();
  using ConversationState = const char *(*)();

  struct Hooks {
    DisplayCode displayCode = nullptr; // Wire a real OLED only after identifying controller/pins.
    ApplyCommand apply = nullptr; // Return true only after the command has actually applied.
    CredentialsChanged credentials = nullptr;
    AccessRevoked revoked = nullptr;
    ConversationState conversation = nullptr;
    bool usbPairing = false; // Explicit local USB request, never an unsolicited log.
  };

  // Call only from a trusted local provisioning channel. Unique secret per device,
  // operator-registered server-side; never a fleet-wide secret or a MAC password.
  static bool provision(const String &origin, const String &uniqueBootstrapSecret,
                        const String &voiceHost, uint16_t voicePort,
                        const String &trustedRootCa) {
    if (!validOrigin(origin) || uniqueBootstrapSecret.length() < 32 ||
        uniqueBootstrapSecret.length() > 256 || !validHost(voiceHost) || !voicePort ||
        trustedRootCa.length() > 6144 ||
        !trustedRootCa.startsWith("-----BEGIN CERTIFICATE-----") ||
        trustedRootCa.indexOf("-----END CERTIFICATE-----") < 0) return false;
    for (size_t i = 0; i < uniqueBootstrapSecret.length(); ++i)
      if (uniqueBootstrapSecret[i] <= ' ' || uniqueBootstrapSecret[i] > '~') return false;
    JsonDocument configuration;
    configuration["origin"] = origin;
    configuration["bootstrap"] = uniqueBootstrapSecret;
    configuration["voicehost"] = voiceHost;
    configuration["voiceport"] = voicePort;
    configuration["rootca"] = trustedRootCa;
    String serialized; serializeJson(configuration, serialized);
    Preferences store;
    if (!store.begin("robot-mgmt", false)) return false;
    // Store the configuration in one NVS value so a failed write cannot mix hosts
    // and credentials from two different provisioning attempts.
    store.putString("config", serialized);
    const bool stored = store.getString("config", "") == serialized;
    if (!stored) { store.end(); return false; }
    store.remove("token"); store.remove("refresh");
    store.end();
    return true;
  }

  bool begin(const char *trustedRootCa, Hooks hooks) {
    if (task) return false;
    callbacks = hooks;
    Preferences store;
    if (!store.begin("robot-mgmt", true)) {
      Serial.println("[management] Setup required: provision management through the USB cable.");
      return false;
    }
    const String saved = store.getString("config", "");
    JsonDocument configuration;
    if (!saved.isEmpty()) {
      if (deserializeJson(configuration, saved)) { store.end(); return false; }
      origin = configuration["origin"] | "";
      bootstrapSecret = configuration["bootstrap"] | "";
      voiceHost = configuration["voicehost"] | "";
      voicePort = configuration["voiceport"] | 443;
      rootCa = configuration["rootca"] | "";
    } else {
      // Keep devices provisioned by the original local provisioning hook usable.
      origin = store.getString("origin", "");
      bootstrapSecret = store.getString("bootstrap", "");
      voiceHost = store.getString("voicehost", "");
      voicePort = static_cast<uint16_t>(store.getUInt("voiceport", 443));
      rootCa = trustedRootCa ? trustedRootCa : "";
    }
    refreshToken = store.getString("refresh", "");
    store.end();
    if (!validOrigin(origin) || bootstrapSecret.length() < 32 || !validHost(voiceHost) ||
        !voicePort || rootCa.isEmpty()) {
      Serial.println("[management] Setup required: use the USB management command to provision HTTPS, CA and device identity.");
      return false;
    }
    pairingMutex = xSemaphoreCreateMutex();
    if (!pairingMutex) return false;
    connectionId = randomId(); nonce = randomId();
    if (!callbacks.displayCode && callbacks.usbPairing)
      Serial.println("[management] Request the pairing code explicitly using the USB pairing_code command.");
    else if (!callbacks.displayCode)
      Serial.println("[management] Setup required: attach an identified OLED or enable explicit USB pairing.");
    return xTaskCreate(taskEntry, "Management", 12288, this, 1, &task) == pdPASS;
  }

  // The display can be attached later without guessing hardware. No pairing code is logged.
  bool displayAvailable() const { return callbacks.displayCode != nullptr; }
  const char *trustedRootCa() const { return rootCa.c_str(); }

  bool pairingCode(String &code, String &expiresAt) {
    if (!callbacks.usbPairing || !pairingMutex) return false;
    xSemaphoreTake(pairingMutex, portMAX_DELAY);
    const bool available = !pendingCode.isEmpty() &&
        static_cast<int32_t>(millis() - pendingCodeDeadline) < 0;
    if (available) { code = pendingCode; expiresAt = pendingCodeExpiresAt; }
    xSemaphoreGive(pairingMutex);
    return available;
  }

private:
  class BoundedResponse : public Stream {
  public:
    explicit BoundedResponse(Stream &input) : source(input) { setTimeout(8000); }
    int available() override { return remaining ? min(source.available(), static_cast<int>(remaining)) : 0; }
    int read() override { if (!remaining) return -1; const int value = source.read(); if (value >= 0) --remaining; return value; }
    int peek() override { return remaining ? source.peek() : -1; }
    void flush() override {}
    size_t write(uint8_t) override { return 0; }
  private:
    Stream &source;
    size_t remaining = 32768;
  };
  TaskHandle_t task = nullptr;
  String rootCa;
  Hooks callbacks;
  String origin, bootstrapSecret, voiceHost, token, refreshToken;
  String connectionId, nonce, claimId;
  uint16_t voicePort = 443;
  uint32_t refreshAt = 0;
  bool notified = false;
  SemaphoreHandle_t pairingMutex = nullptr;
  String pendingCode, pendingCodeExpiresAt;
  uint32_t pendingCodeDeadline = 0;

  static bool validHost(const String &host) {
    if (host.isEmpty() || host.length() > 253 || host[0] == '.' || host.endsWith(".")) return false;
    for (size_t i = 0; i < host.length(); ++i) {
      const char value = host[i];
      if (!((value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
            (value >= '0' && value <= '9') || value == '-' || value == '.')) return false;
    }
    return true;
  }

  static bool validOrigin(const String &origin) {
    if (!origin.startsWith("https://") || origin.length() > 280) return false;
    String authority = origin.substring(8);
    if (authority.endsWith("/")) authority.remove(authority.length() - 1);
    const int colon = authority.indexOf(':');
    if (colon < 0) return validHost(authority);
    const String host = authority.substring(0, colon);
    const String portText = authority.substring(colon + 1);
    const long port = portText.toInt();
    return validHost(host) && port > 0 && port <= 65535 && portText == String(port);
  }

  void showPairingCode(const String &code, const String &expiresAt) {
    xSemaphoreTake(pairingMutex, portMAX_DELAY);
    pendingCode = code; pendingCodeExpiresAt = expiresAt;
    pendingCodeDeadline = millis() + 5UL * 60UL * 1000UL;
    xSemaphoreGive(pairingMutex);
    if (callbacks.displayCode) callbacks.displayCode(code, expiresAt);
  }

  static String randomId() {
    char out[65];
    for (unsigned i = 0; i < 8; ++i) snprintf(out + i * 8, 9, "%08lx", (unsigned long)esp_random());
    return String(out);
  }

  int request(JsonDocument &body, JsonDocument &response) {
    if (WiFi.status() != WL_CONNECTED) return -1;
    WiFiClientSecure tls; tls.setCACert(rootCa.c_str()); tls.setTimeout(8);
    HTTPClient http; http.setTimeout(8000); http.setConnectTimeout(8000);
    http.useHTTP10(true); // Avoid exposing HTTP chunk framing to ArduinoJson's stream reader.
    http.setFollowRedirects(HTTPC_DISABLE_FOLLOW_REDIRECTS);
    String endpoint = origin;
    while (endpoint.endsWith("/")) endpoint.remove(endpoint.length() - 1);
    endpoint += "/api/device";
    if (!http.begin(tls, endpoint)) return -1;
    http.addHeader("Content-Type", "application/json");
    const String bearer = body["token"] | "";
    if (!bearer.isEmpty()) http.addHeader("Authorization", "Bearer " + bearer);
    String json; serializeJson(body, json);
    const int status = http.POST(json);
    // Requests and response bodies contain credentials: do not print either.
    if (status == 200) {
      const int length = http.getSize();
      if (length > 32768) { http.end(); return -1; }
      // Parse directly with ArduinoJson; total response is bounded by the management API.
      BoundedResponse bounded(http.getStream());
      const DeserializationError error = deserializeJson(response, bounded);
      if (error) { http.end(); return -1; }
      if (response["data"].is<JsonObject>()) {
        JsonDocument unwrapped; unwrapped.set(response["data"]);
        response.set(unwrapped);
      }
    }
    http.end(); return status;
  }

  bool acceptCredentials(JsonDocument &response) {
    String nextToken = response["token"] | "";
    String nextRefresh = response["refreshToken"] | "";
    if (nextToken.isEmpty() || nextRefresh.isEmpty()) return false;
    token = nextToken; refreshToken = nextRefresh; refreshAt = millis() + 10UL * 60UL * 1000UL;
    Preferences store;
    if (!store.begin("robot-mgmt", false)) return false;
    // NVS encryption/secure boot must be configured for the deployed board separately.
    store.putString("token", token); store.putString("refresh", refreshToken); store.end();
    if (callbacks.credentials) callbacks.credentials(token, voiceHost, voicePort);
    notified = true;
    return true;
  }

  void clearCredentials() {
    token = ""; refreshToken = "";
    Preferences store;
    if (store.begin("robot-mgmt", false)) {
      store.remove("token"); store.remove("refresh"); store.end();
    }
    if (notified && callbacks.revoked) callbacks.revoked();
    notified = false;
  }

  bool refresh() {
    JsonDocument requestBody, response;
    requestBody["action"] = "refresh"; requestBody["refreshToken"] = refreshToken;
    const int status = request(requestBody, response);
    if (status == 200) return acceptCredentials(response);
    if (status == 401 || status == 403) clearCredentials();
    return false;
  }

  bool bootstrap() {
    JsonDocument requestBody, response;
    requestBody["action"] = "bootstrap"; requestBody["mac"] = WiFi.macAddress();
    requestBody["bootstrapSecret"] = bootstrapSecret;
    requestBody["connectionId"] = connectionId; requestBody["nonce"] = nonce;
    if (request(requestBody, response) != 200) return false;
    claimId = response["claimId"] | "";
    const String code = response["code"] | "";
    const String expires = response["expiresAt"] | "";
    if (claimId.isEmpty() || code.isEmpty()) return false;
    if (callbacks.displayCode || callbacks.usbPairing) showPairingCode(code, expires);
    else {
      Serial.println("[management] Setup required: connect the identified OLED or use explicit USB pairing.");
      return false;
    }
    const uint32_t deadline = millis() + 5UL * 60UL * 1000UL;
    while ((int32_t)(millis() - deadline) < 0) {
      vTaskDelay(pdMS_TO_TICKS(3000));
      JsonDocument check, result;
      check["action"] = "claim_status"; check["mac"] = WiFi.macAddress();
      check["bootstrapSecret"] = bootstrapSecret; check["claimId"] = claimId;
      check["connectionId"] = connectionId; check["nonce"] = nonce;
      const int status = request(check, result);
      if (status == 200 && String(result["status"] | "") == "paired") {
        showPairingCode("", "");
        return acceptCredentials(result);
      }
      if (status == 401 || status == 403 || status == 410) break;
    }
    showPairingCode("", "");
    nonce = randomId(); return false;
  }

  void heartbeat() {
    JsonDocument requestBody, response;
    requestBody["action"] = "heartbeat"; requestBody["token"] = token;
    requestBody["connectionId"] = connectionId;
    requestBody["conversation"] = callbacks.conversation ? callbacks.conversation() : "idle";
    JsonArray capabilities = requestBody["capabilities"].to<JsonArray>();
    capabilities.add("config_ack");
    if (callbacks.apply) capabilities.add("volume");
    if (callbacks.displayCode) capabilities.add("pairing_display");
    if (callbacks.usbPairing) capabilities.add("pairing_usb");
    const int status = request(requestBody, response);
    if (status == 401 || status == 403) { clearCredentials(); return; }
    if (status != 200) return;
    for (JsonObjectConst command : response["commands"].as<JsonArrayConst>()) {
      const String id = command["id"] | "";
      const String type = command["type"] | "";
      if (id.isEmpty()) continue;
      const String expiresAt = command["expiresAt"] | "";
      int year, month, day, hour, minute, second;
      if (sscanf(expiresAt.c_str(), "%d-%d-%dT%d:%d:%d", &year, &month, &day,
                 &hour, &minute, &second) != 6) continue;
      struct tm expiry = {};
      expiry.tm_year = year - 1900; expiry.tm_mon = month - 1; expiry.tm_mday = day;
      expiry.tm_hour = hour; expiry.tm_min = minute; expiry.tm_sec = second;
      // setupManagement configures UTC; reject stale commands before application.
      if (time(nullptr) >= mktime(&expiry)) continue;
      String error;
      const bool applied = callbacks.apply && callbacks.apply(type, command["payload"], error);
      JsonDocument ack, result;
      ack["action"] = "ack"; ack["token"] = token; ack["commandId"] = id;
      ack["status"] = applied ? "applied" : "failed";
      if (applied && !command["payload"]["configVersion"].isNull())
        ack["configVersion"] = command["payload"]["configVersion"];
      if (!applied) ack["error"] = error.isEmpty() ? "unsupported_firmware_command" : error;
      request(ack, result);
    }
  }

  static void taskEntry(void *argument) {
    ManagementProtocol *self = static_cast<ManagementProtocol *>(argument);
    for (;;) {
      // Trusted TLS certificate validity and command expiry need a synchronized clock.
      if (WiFi.status() == WL_CONNECTED && time(nullptr) > 1700000000) {
        if (self->token.isEmpty()) {
          if (!self->refreshToken.isEmpty()) self->refresh();
          else if (self->callbacks.displayCode || self->callbacks.usbPairing) self->bootstrap();
        } else if ((int32_t)(millis() - self->refreshAt) >= 0) self->refresh();
        if (!self->token.isEmpty()) self->heartbeat();
      }
      vTaskDelay(pdMS_TO_TICKS(10000));
    }
  }
};
#endif
