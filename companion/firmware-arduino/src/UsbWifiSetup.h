#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <cstring>
#include "Config.h"
#include "Audio.h"
#ifdef ELATO_MANAGEMENT
#include "ManagementProtocol.h"
bool readUsbManagementPairingCode(String &code, String &expiresAt);
#endif

namespace elato_usb_wifi_setup {

// A bounded reader also lets us reject bytes after the JSON object.
struct JsonInput {
  const char *data;
  size_t length;
  size_t position = 0;

  int read() {
    return position < length ? static_cast<unsigned char>(data[position++]) : -1;
  }
  size_t readBytes(char *output, size_t count) {
    const size_t available = length - position;
    if (count > available) count = available;
    std::memcpy(output, data + position, count);
    position += count;
    return count;
  }
};

inline bool equals(JsonString value, const char *expected) {
  const size_t length = std::strlen(expected);
  return !value.isNull() && value.size() == length &&
         std::memcmp(value.c_str(), expected, length) == 0;
}

inline bool busy() {
  return shutdownInProgress || otaState != OTA_IDLE || deviceState == OTA;
}

inline bool privateRelayAddress(const char *host, IPAddress &address) {
  if (!host || std::strlen(host) > 15 || !address.fromString(host)) return false;
  return address[0] == 10 || (address[0] == 172 && address[1] >= 16 && address[1] <= 31) ||
         (address[0] == 192 && address[1] == 168);
}

inline void loadRelay() {
  Preferences route;
  if (!route.begin("elato_relay", true)) return;
  const String endpoint = route.getString("endpoint", "");
  route.end();
  if (endpoint.isEmpty()) return;
  const int separator = endpoint.indexOf(':');
  const String host = endpoint.substring(0, separator);
  const long port = endpoint.substring(separator + 1).toInt();
  IPAddress address;
  // toInt() accepts signs and trailing text; require the saved canonical form.
  if (separator <= 0 || endpoint.length() > 21 || port < 1024 || port > 65535 ||
      !privateRelayAddress(host.c_str(), address) ||
      endpoint != address.toString() + ":" + String(port)) {
    webSocket.configureRelay(IPAddress(), 0); // Invalid saved relay must fail closed.
    Serial.println("[RELAY] Invalid saved endpoint; reconfigure through USB");
    return;
  }
  webSocket.configureRelay(address, static_cast<uint16_t>(port));
  Serial.printf("[RELAY] Laptop endpoint=%s:%ld; original server TLS verification enabled\n",
                host.c_str(), port);
}

inline void saveRelay(JsonString host, uint16_t port, bool clear = false) {
  IPAddress address;
  if (!clear && (host.isNull() || std::strlen(host.c_str()) != host.size() ||
                 port < 1024 || !privateRelayAddress(host.c_str(), address))) {
    Serial.println("[SETUP] ERROR_COMMAND");
    return;
  }
  Preferences route;
  if (!route.begin("elato_relay", false)) {
    Serial.println("[SETUP] ERROR_STORAGE");
    return;
  }
  const String oldEndpoint = route.getString("endpoint", "");
  const String endpoint = clear ? String("") : address.toString() + ":" + String(port);
  route.putString("endpoint", endpoint);
  if (route.getString("endpoint", "!read_failed!") != endpoint) {
    route.putString("endpoint", oldEndpoint);
    route.end();
    Serial.println("[SETUP] ERROR_STORAGE");
    return;
  }
  route.end();
  Serial.println(clear ? "[SETUP] RELAY_CLEARED" : "[SETUP] RELAY_SAVED");
  Serial.flush();
  delay(100);
  ESP.restart();
}

inline bool storedValueMatches(Preferences &store, const char *key,
                               const char *value, size_t length) {
  char saved[64] = {};
  return store.isKey(key) && store.getType(key) == PT_STR &&
         store.getString(key, saved, sizeof(saved)) == length + 1 &&
         saved[length] == '\0' && std::memcmp(saved, value, length) == 0;
}

inline bool snapshot(Preferences &store, const char *key, bool &present,
                     char *value, size_t capacity) {
  present = store.isKey(key);
  if (!present) return true;
  if (store.getType(key) != PT_STR) return false;
  const size_t count = store.getString(key, value, capacity);
  return count > 0 && count <= capacity && value[count - 1] == '\0' &&
         std::strlen(value) + 1 == count;
}

inline bool restore(Preferences &store, const char *key, bool present,
                    const char *value) {
  if (present) {
    store.putString(key, value);
    return storedValueMatches(store, key, value, std::strlen(value));
  }
  if (store.isKey(key)) store.remove(key);
  return !store.isKey(key);
}

inline void saveWifi(JsonString ssidValue, JsonString passwordValue) {
  const size_t ssidLength = ssidValue.size();
  const size_t passwordLength = passwordValue.size();
  if (ssidValue.isNull() || passwordValue.isNull() || ssidLength < 1 ||
      ssidLength > 32 || (passwordLength != 0 &&
                        (passwordLength < 8 || passwordLength > 63)) ||
      std::memchr(ssidValue.c_str(), '\0', ssidLength) ||
      std::memchr(passwordValue.c_str(), '\0', passwordLength)) {
    Serial.println("[SETUP] ERROR_CREDENTIALS");
    return;
  }

  // This handle is separate from the application's global Preferences object.
  Preferences store;
  if (!store.begin("wifimanager", false)) {
    Serial.println("[SETUP] ERROR_STORAGE");
    return;
  }
  bool oldNamePresent = false;
  bool oldPasswordPresent = false;
  char oldName[33] = {};
  char oldPassword[64] = {};
  if (!snapshot(store, "apName0", oldNamePresent, oldName, sizeof(oldName)) ||
      !snapshot(store, "apPass0", oldPasswordPresent, oldPassword, sizeof(oldPassword))) {
    store.end();
    Serial.println("[SETUP] ERROR_STORAGE");
    return;
  }
  // Check again immediately before writing; other tasks can request shutdown.
  if (busy()) {
    store.end();
    Serial.println("[SETUP] ERROR_BUSY");
    return;
  }

  const bool nameWritten = store.putString("apName0", ssidValue.c_str()) == ssidLength;
  const bool passwordWritten = nameWritten &&
      store.putString("apPass0", passwordValue.c_str()) == passwordLength;
  // putString("") returns zero even on success: key existence and readback
  // distinguish a successfully stored open-network password from a failure.
  const bool verified = nameWritten && passwordWritten &&
      storedValueMatches(store, "apName0", ssidValue.c_str(), ssidLength) &&
      storedValueMatches(store, "apPass0", passwordValue.c_str(), passwordLength);
  if (!verified) {
    const bool nameRestored = restore(store, "apName0", oldNamePresent, oldName);
    const bool passwordRestored = restore(store, "apPass0", oldPasswordPresent, oldPassword);
    store.end();
    Serial.println(nameRestored && passwordRestored
                       ? "[SETUP] ERROR_STORAGE"
                       : "[SETUP] ERROR_STORAGE_ROLLBACK");
    return;
  }

  Serial.println("[SETUP] WIFI_SAVED");
  store.end();
  Serial.flush();
  delay(100);
  ESP.restart();
}

inline void processLine(const char *line, size_t length) {
  static constexpr char prefix[] = "ELATO_SETUP ";
  constexpr size_t prefixLength = sizeof(prefix) - 1;
  if (length < prefixLength || std::memcmp(line, prefix, prefixLength) != 0 ||
      std::memchr(line, '\0', length)) {
    Serial.println("[SETUP] ERROR_COMMAND");
    return;
  }
  JsonDocument document;
  JsonInput input{line + prefixLength, length - prefixLength};
  const DeserializationError error = deserializeJson(
      document, input, DeserializationOption::NestingLimit(3));
  while (input.position < input.length &&
         (input.data[input.position] == ' ' || input.data[input.position] == '\t' ||
          input.data[input.position] == '\r')) {
    ++input.position;
  }
  if (error || !document.is<JsonObject>() || input.position != input.length ||
      !document["cmd"].is<JsonString>()) {
    Serial.println("[SETUP] ERROR_JSON");
    return;
  }
  if (busy()) {
    Serial.println("[SETUP] ERROR_BUSY");
    return;
  }
  const JsonString command = document["cmd"].as<JsonString>();
  if (equals(command, "status")) {
    Serial.println("[SETUP] READY");
  } else if (equals(command, "network_status")) {
    Serial.printf("[SETUP] NETWORK ip=%s mac=%s\n", WiFi.localIP().toString().c_str(),
                  WiFi.macAddress().c_str());
#ifdef ELATO_MANAGEMENT
  } else if (equals(command, "management")) {
    if (!document["origin"].is<JsonString>() ||
        !document["bootstrapSecret"].is<JsonString>() ||
        !document["voiceHost"].is<JsonString>() ||
        !document["ca"].is<JsonString>() ||
        (document["voicePort"].isNull() == false && !document["voicePort"].is<uint16_t>())) {
      Serial.println("[SETUP] ERROR_COMMAND");
      return;
    }
    for (const char *key : {"origin", "bootstrapSecret", "voiceHost", "ca"}) {
      const JsonString value = document[key].as<JsonString>();
      if (std::memchr(value.c_str(), '\0', value.size())) {
        Serial.println("[SETUP] ERROR_COMMAND");
        return;
      }
    }
    if (!ManagementProtocol::provision(document["origin"].as<String>(),
                                      document["bootstrapSecret"].as<String>(),
                                      document["voiceHost"].as<String>(),
                                      document["voicePort"] | 443,
                                      document["ca"].as<String>())) {
      Serial.println("[SETUP] ERROR_MANAGEMENT_CONFIG");
      return;
    }
    Serial.println("[SETUP] MANAGEMENT_SAVED");
    Serial.flush(); delay(100); ESP.restart();
  } else if (equals(command, "pairing_code")) {
    String code, expiresAt;
    if (readUsbManagementPairingCode(code, expiresAt)) {
      JsonDocument response;
      response["code"] = code; response["expiresAt"] = expiresAt;
      Serial.print("[SETUP] PAIRING "); serializeJson(response, Serial); Serial.println();
    } else {
      Serial.println("[SETUP] PAIRING_PENDING");
    }
#endif
  } else if (equals(command, "relay")) {
    if (!document["host"].is<JsonString>() || !document["port"].is<uint16_t>()) {
      Serial.println("[SETUP] ERROR_COMMAND");
      return;
    }
    saveRelay(document["host"].as<JsonString>(), document["port"].as<uint16_t>());
  } else if (equals(command, "relay_clear")) {
    saveRelay(JsonString(), 0, true);
  } else if (equals(command, "wifi")) {
    if (!document["ssid"].is<JsonString>() || !document["password"].is<JsonString>()) {
      Serial.println("[SETUP] ERROR_CREDENTIALS");
      return;
    }
    saveWifi(document["ssid"].as<JsonString>(), document["password"].as<JsonString>());
  } else {
    Serial.println("[SETUP] ERROR_COMMAND");
  }
}

} // namespace elato_usb_wifi_setup

inline void loadUsbRelayConfiguration() {
  elato_usb_wifi_setup::loadRelay();
}

inline void processUsbWifiSetup() {
  // A provisioned PEM root/bundle and JSON escaping must fit without truncation.
  static char line[8192] = {};
  static size_t used = 0;
  static bool discardUntilNewline = false;
  static unsigned long lastByteAt = 0;

  if (used && millis() - lastByteAt >= 5000) {
    std::memset(line, 0, sizeof(line));
    used = 0;
    discardUntilNewline = true;
    Serial.println("[SETUP] ERROR_TIMEOUT");
  }
  // Limit work per call so serial flooding cannot monopolize the main loop.
  for (size_t count = 0; count < 1024 && Serial.available() > 0; ++count) {
    const int input = Serial.read();
    if (input < 0) break;
    const char value = static_cast<char>(input);
    if (value == '\n') {
      if (!discardUntilNewline && used) {
        if (line[used - 1] == '\r') --used;
        line[used] = '\0';
        if (used) elato_usb_wifi_setup::processLine(line, used);
      }
      std::memset(line, 0, sizeof(line));
      used = 0;
      discardUntilNewline = false;
    } else if (!discardUntilNewline) {
      if (used == sizeof(line) - 1) {
        std::memset(line, 0, sizeof(line));
        used = 0;
        discardUntilNewline = true;
        Serial.println("[SETUP] ERROR_LENGTH");
      } else {
        line[used++] = value;
        lastByteAt = millis();
      }
    }
  }
}
