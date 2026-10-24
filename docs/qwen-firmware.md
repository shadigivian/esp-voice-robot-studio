# Qwen firmware and the supplied ESP32-S3 wiring

The default firmware now uses `ELATO_MANAGEMENT` and the self-hosted `/managed-voice` endpoint. The server owns the Qwen API key. The device receives scoped, refreshed device credentials from the management API; it does not call the legacy hosted token endpoint. `DEV_MODE` does not disable TLS for managed connections.

The existing local PlatformIO hardware settings (16 MB flash and OPI PSRAM) are retained. Confirm the exact module marking before uploading to a different board. A successful compile does not verify the physical circuit, speaker output, available power, microphone, or network access.

## Wiring

- INMP441: 3V3, GND, SCK GPIO1, WS GPIO4, SD GPIO14, L/R GND. Capture is left-channel I2S with 32-bit physical slots, converted to PCM16 mono at 16 kHz.
- MAX98357A: VIN 5V, common GND, BCLK GPIO6, LRC GPIO5, DIN GPIO7, GAIN GND, SD VIN. `ELATO_AMP_SD_PIN=-1` prevents GPIO access to the fixed-high SD connection. Speaker connects between SPK+ and SPK-.
- Playback is Opus from the server, decoded to 48 kHz PCM16 for the amplifier. Qwen's 24 kHz PCM must be encoded on the server. The firmware does not send a 24 kHz I2S clock to MAX98357A.
- Playback and microphone transmission remain half duplex. DMA clearing and TX-underflow silence work when the amplifier cannot be muted by GPIO.
- TTP223: 3V3, GND, digital active-HIGH OUT GPIO2. Use momentary mode; double touch or a long press sleeps, and a fresh touch wakes the board. The conversation listens automatically after the server starts the session.
- OLED: 3V3, GND, SDA GPIO8, SCL GPIO9. Controller, geometry, and address remain unknown. RGB LED output on GPIO8/9 is disabled. The firmware deliberately leaves the display uninitialized until its model is identified.

## Provisioning through trusted USB

Serial uses **115200 baud**. Every command is one UTF-8 line ending in LF. Configure Wi-Fi first:

```json
ELATO_SETUP {"cmd":"wifi","ssid":"YOUR_WIFI","password":"YOUR_PASSWORD"}
```

It replies `[SETUP] WIFI_SAVED` and reboots. Read the station MAC for server-side provisioning:

```json
ELATO_SETUP {"cmd":"network_status"}
```

Register that MAC and a unique random bootstrap secret in the management server using its operator provisioning command. Configure the device using the same secret:

```json
ELATO_SETUP {"cmd":"management","origin":"https://panel.example.com","bootstrapSecret":"UNIQUE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS","voiceHost":"voice.example.com","voicePort":443,"ca":"-----BEGIN CERTIFICATE-----\nROOT_CA_BASE64\n-----END CERTIFICATE-----\n"}
```

This example contains a placeholder certificate. Supply the actual trusted root CA or PEM bundle for both the management HTTPS endpoint and the voice WebSocket endpoint. A script should JSON-serialize the PEM string so its physical line breaks become `\n` escapes within the single serial line. No cloud API key belongs in this command.

`origin` accepts HTTPS with an optional numeric port and trailing slash; it has no path, query, user information, or fragment. `voiceHost` is a hostname or IPv4 address without a scheme or path. `voicePort` defaults to 443. The secret is 32–256 printable ASCII characters without whitespace, the CA is at most 6144 characters, and the full command must be shorter than 8192 bytes. Valid settings are stored together in NVS. `[SETUP] MANAGEMENT_SAVED` means the verified write succeeded and the device will reboot; an invalid configuration returns `[SETUP] ERROR_MANAGEMENT_CONFIG`.

After Wi-Fi and NTP become available, the device requests a pairing code. Request it explicitly through the local USB cable:

```json
ELATO_SETUP {"cmd":"pairing_code"}
```

A ready code returns `[SETUP] PAIRING {"code":"...","expiresAt":"..."}`. `[SETUP] PAIRING_PENDING` means there is no current code: wait for the bootstrap request, then request it again. Enter the code in the authenticated management panel. Until the OLED is identified this provides pairing without guessing its driver. Pairing codes, bootstrap secrets, and scoped tokens are never printed automatically.

The management task then refreshes device credentials, connects to `/managed-voice` using the configured CA, and reports `pairing_usb`, `config_ack`, and volume capabilities. Secure boot and NVS encryption remain board deployment settings; they are not enabled by this source change.

## Build

```powershell
platformio run -e esp32-s3-devkitc-1
```

The configured COM7 is an existing local port setting. Select the actual USB port when uploading or opening the monitor. No device is flashed by a normal `run` command.
