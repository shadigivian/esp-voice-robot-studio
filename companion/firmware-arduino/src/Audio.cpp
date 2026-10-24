#include "OTA.h"
#include "Audio.h"
#include "PitchShift.h"
#include <cstring>
#ifdef ELATO_DIAGNOSTICS
#include <atomic>
#include <cmath>

namespace {
// Metadata only. Each audio task keeps its samples in its existing buffers.
std::atomic<uint32_t> micBytes{0}, micTxBytes{0}, micTxOk{0}, micTxFailed{0};
std::atomic<uint32_t> replyPackets{0}, replyBytes{0}, decodedBytes{0};
std::atomic<uint32_t> decodedPeak{0}, playedBytes{0}, lastReplyMs{0};
std::atomic<uint32_t> maxReadMs{0}, maxMutexMs{0}, maxSendMs{0}, maxNetworkMs{0};
std::atomic<uint32_t> sendElapsedMs{0}, mutexElapsedMs{0};
uint64_t micSquares = 0;
int64_t micSum = 0;
uint32_t micSamples = 0, micPeak = 0, micClipped = 0, micReportMs = 0;

void recordMaximum(std::atomic<uint32_t> &maximum, uint32_t value) {
    // Each maximum has a single writing task.
    if (value > maximum.load(std::memory_order_relaxed))
        maximum.store(value, std::memory_order_relaxed);
}

void countDecodedAudio(const uint8_t *data, size_t length) {
    decodedBytes.fetch_add(length, std::memory_order_relaxed);
    uint32_t peak = 0;
    for (size_t offset = 0; offset + sizeof(int16_t) <= length; offset += sizeof(int16_t)) {
        int16_t sample;
        std::memcpy(&sample, data + offset, sizeof(sample));
        const uint32_t magnitude = sample < 0 ? -static_cast<int32_t>(sample) : sample;
        if (magnitude > peak) peak = magnitude;
    }
    // Only the network/decoder task writes this peak; the main loop reads it.
    if (peak > decodedPeak.load(std::memory_order_relaxed))
        decodedPeak.store(peak, std::memory_order_relaxed);
}
} // namespace

void reportAudioDiagnostics() {
    Serial.printf("[VOICE] ms=%lu state=%d amp=%d queue=%u tx_bytes=%lu tx_ok=%lu "
                  "tx_fail=%lu rx_packets=%lu rx_bytes=%lu decoded_bytes=%lu "
                  "decoded_peak16=%lu played_bytes=%lu rx_age_ms=%lu volume=%d pitch=%.2f\n",
                  millis(), static_cast<int>(deviceState), amplifierEnabledLevel(),
                  static_cast<unsigned>(audioBuffer.available()),
                  static_cast<unsigned long>(micTxBytes.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(micTxOk.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(micTxFailed.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(replyPackets.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(replyBytes.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(decodedBytes.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(decodedPeak.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(playedBytes.load(std::memory_order_relaxed)),
                  millis() - lastReplyMs.load(std::memory_order_relaxed), currentVolume,
                  currentPitchFactor);
    Serial.printf("[VOICE-TIMING] wifi=%d rssi=%d read_max_ms=%lu mutex_max_ms=%lu send_max_ms=%lu "
                  "network_max_ms=%lu send_total_ms=%lu mutex_total_ms=%lu\n",
                  static_cast<int>(WiFi.status()), WiFi.RSSI(),
                  static_cast<unsigned long>(maxReadMs.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(maxMutexMs.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(maxSendMs.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(maxNetworkMs.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(sendElapsedMs.load(std::memory_order_relaxed)),
                  static_cast<unsigned long>(mutexElapsedMs.load(std::memory_order_relaxed)));
}
#endif

// WEBSOCKET
SemaphoreHandle_t wsMutex;
RelayWebSocketsClient webSocket;

// TASK HANDLES
TaskHandle_t speakerTaskHandle = NULL;
TaskHandle_t micTaskHandle = NULL;
TaskHandle_t networkTaskHandle = NULL;

// TIMING REGISTERS
volatile bool scheduleListeningRestart = false;
unsigned long scheduledTime = 0;
unsigned long speakingStartTime = 0;
// Live completion is a playback handoff, not a forced one-second restart.
// Only networkTask accesses the IDs; speakerTask publishes its write status.
uint32_t activePlaybackId = 0;
uint32_t pendingPlaybackId = 0;
volatile bool speakerCopyActive = false;
volatile unsigned long lastSpeakerWriteTime = 0;
unsigned long playbackDrainRequestedTime = 0;
unsigned long speakerDrainGuardMs = 250;

// AUDIO SETTINGS
int currentVolume = 70;
float currentPitchFactor = 1.0f;
const int CHANNELS = 1;         // Mono
const int BITS_PER_SAMPLE = 16; // 16-bit audio

// AUDIO OUTPUT
class BufferPrint : public Print {
public:
  explicit BufferPrint(BufferRTOS<uint8_t>& buf) : _buffer(buf) {}

  // networkTask -> webSocket.loop() -> webSocketEvent(WStype_BIN, ...) -> opusDecoder.write() -> bufferPrint.write()
  virtual size_t write(uint8_t data) override {
    if (webSocket.isConnected() && deviceState == SPEAKING) {
        return _buffer.writeArray(&data, 1);
    }
    return 1; //let opusDecoder write, otherwise thread will stuck
  }

  // networkTask -> webSocket.loop() -> webSocketEvent(WStype_BIN, ...) -> opusDecoder.write() -> bufferPrint.write()
  virtual size_t write(const uint8_t *buffer, size_t size) override {
    if (webSocket.isConnected() && deviceState == SPEAKING) {
#ifdef ELATO_DIAGNOSTICS
        countDecodedAudio(buffer, size);
#endif
        return _buffer.writeArray(buffer, size);
    }
    return size; //let opusDecoder write, otherwise thread will stuck
  }

private:
  BufferRTOS<uint8_t>& _buffer;
};

BufferPrint bufferPrint(audioBuffer);
OpusAudioDecoder opusDecoder;  //access guarded by wsmutex
BufferRTOS<uint8_t> audioBuffer(AUDIO_BUFFER_SIZE, AUDIO_CHUNK_SIZE);  //producer: networkTask, consumer: audioStreamTask. Thread safe in single producer->single consumer scenario.
I2SStream i2s; //access from audioStreamTask only

// OLD with no pitch shift
VolumeStream volume(i2s); //access from audioStreamTask only
QueueStream<uint8_t> queue(audioBuffer); //access from audioStreamTask only
StreamCopy copier(volume, queue);

// NEW for pitch shift (lossy)
PitchShiftFixedOutput pitchShift(i2s);
VolumeStream volumePitch(pitchShift); //access from audioStreamTask only
StreamCopy pitchCopier(volumePitch, queue);

AudioInfo info(SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE);
volatile bool i2sOutputFlushScheduled = false;
volatile bool discardCancelledPlayback = false;

void clearVoicePlayback() {
    deviceState = PROCESSING;
    scheduleListeningRestart = false;
    activePlaybackId = pendingPlaybackId = 0;
    setAmplifierEnabled(false);
    i2sInputFlushScheduled = true;
    discardCancelledPlayback = true;
    i2sOutputFlushScheduled = true;
    // begin() reinitializes Opus state in its retained vector-owned storage.
    // Do not call this bundled decoder's end(): it separately destroys the
    // vector-owned decoder pointer. Also avoid allocating before initial setup.
    if (opusDecoder) opusDecoder.begin();
}

unsigned long getSpeakingDuration() {
    if (deviceState == SPEAKING && speakingStartTime > 0) {
        return millis() - speakingStartTime;
    }
    return 0;
}

// networkTask -> webSocket.loop() -> webSocketEvent(WStype_TEXT, ...) -> transitionToSpeaking()
void transitionToSpeaking() {
    if (shutdownInProgress) return;
    const uint32_t clearDeadline = millis() + 500;
    while (discardCancelledPlayback && (int32_t)(millis() - clearDeadline) < 0)
        vTaskDelay(1);
    if (discardCancelledPlayback) return; // Speaker has not acknowledged a clean output queue.
#ifdef ELATO_DIAGNOSTICS
    decodedPeak.store(0, std::memory_order_relaxed);
#endif
    scheduleListeningRestart = false;
    pendingPlaybackId = 0;
    vTaskDelay(50);
    if (shutdownInProgress) return;

    i2sInputFlushScheduled = true;

    deviceState = SPEAKING;
    setAmplifierEnabled(true);
    speakingStartTime = millis();

    // webSocket.enableHeartbeat(30000, 15000, 3);

    Serial.println("Transitioned to speaking mode");
}

// networkTask -> transitionToListening()
// ( networkTask -> webSocket.loop() -> webSocketEvent(WStype_TEXT, ...) -> (sets scheduleListeningRestart) -> networkTask -> transitionToListening() )
void transitionToListening() {
    if (shutdownInProgress) return;
    deviceState = PROCESSING;
    scheduleListeningRestart = false;
    pendingPlaybackId = 0;
    Serial.println("Transitioning to listening mode");

    i2sInputFlushScheduled = true;
    i2sOutputFlushScheduled = true;

    Serial.println("Transitioned to listening mode");

    deviceState = LISTENING;
    setAmplifierEnabled(false);
    // webSocket.disableHeartbeat();
}

// audioStreamTask -> copier.copy() (conditional on webSocket.isConnected())
void audioStreamTask(void *parameter) {
    Serial.println("Starting I2S stream pipeline...");

    setupAmplifier();

    OpusSettings cfg;
    cfg.sample_rate = SAMPLE_RATE;
    cfg.channels = CHANNELS;
    cfg.bits_per_sample = BITS_PER_SAMPLE;
    // A 120ms Opus frame decoded at 48kHz mono s16 is 11520 bytes; 6144 only
    // fit the old 24kHz pipeline.
    cfg.max_buffer_size = SAMPLE_RATE * CHANNELS * sizeof(int16_t) * 120 / 1000;

    xSemaphoreTake(wsMutex, portMAX_DELAY);
    opusDecoder.setOutput(bufferPrint);
    opusDecoder.begin(cfg);
    xSemaphoreGive(wsMutex);

    audioBuffer.setReadMaxWait(0);

    queue.begin();

    auto config = i2s.defaultConfig(TX_MODE);
    config.bits_per_sample = BITS_PER_SAMPLE;
    config.sample_rate = SAMPLE_RATE;
    config.channels = CHANNELS;
    config.pin_bck = I2S_BCK_OUT;
    config.pin_ws = I2S_WS_OUT;
    config.pin_data = I2S_DATA_OUT;
    config.port_no = I2S_PORT_OUT;
    config.buffer_count = 4;
    config.buffer_size = 256;
    // SD is tied high on this board: silence the DMA on TX underflow instead
    // of relying on a GPIO hardware mute.
    config.auto_clear = true;

    config.copyFrom(info);
    // Cover all configured DMA samples plus an acoustic tail after the last
    // blocking write. Queue-empty alone does not mean I2S finished playing.
    speakerDrainGuardMs = 250 +
        (1000UL * config.buffer_count * config.buffer_size + SAMPLE_RATE - 1) / SAMPLE_RATE;
    i2s.begin(config);

    // Initialize both volume streams once
    auto vcfg = volume.defaultConfig();
    vcfg.copyFrom(info);
    vcfg.allow_boost = true;
    volume.begin(vcfg);

    auto vcfgPitch = volumePitch.defaultConfig();
    vcfgPitch.copyFrom(info);
    vcfgPitch.allow_boost = true;
    volumePitch.begin(vcfgPitch);

    while (1) {
        if (shutdownInProgress) {
            // Drain a producer already inside the decoder so shutdown can
            // acquire wsMutex, but never write more data to the speaker.
            while (queue.available() > 0) queue.read();
            vTaskDelay(1);
            continue;
        }
        if ( i2sOutputFlushScheduled) {
            i2sOutputFlushScheduled = false;
            i2s.flush();
            volume.flush();
            volumePitch.flush();
            queue.flush();
            i2s_zero_dma_buffer(I2S_PORT_OUT);
            if (discardCancelledPlayback) {
                // I2SStream::flush and QueueStream::flush are no-ops in this version.
                // Only the speaker task may consume this single-consumer queue.
                while (queue.available() > 0) queue.read();
                discardCancelledPlayback = false;
            }
        }

        if (webSocket.isConnected() && deviceState == SPEAKING) {
            speakerCopyActive = true;
            size_t copied = 0;
            if (currentPitchFactor != 1.0f) {
                copied = pitchCopier.copy();
            } else {
                copied = copier.copy();
            }
            if (copied > 0) {
                lastSpeakerWriteTime = millis();
#ifdef ELATO_DIAGNOSTICS
                playedBytes.fetch_add(copied, std::memory_order_relaxed);
#endif
            }
            speakerCopyActive = false;
        }
        else {
            //we should always read from audioBuffer, otherwise writing thread can stuck
            queue.read();
        }
        vTaskDelay(1);
    }
}


class WebsocketStream : public Print {
public:
    // micTask -> micToWsCopier.copyBytes() -> wsStream.write()
    virtual size_t write(uint8_t b) override {
        return write(&b, 1);
    }

    // micTask -> micToWsCopier.copyBytes() -> wsStream.write()
    virtual size_t write(const uint8_t *buffer, size_t size) override {
        if (shutdownInProgress || size == 0 || !webSocket.isConnected() || deviceState != LISTENING) {
            return size;
        }

#ifdef ELATO_DIAGNOSTICS
        const uint32_t waitingSince = millis();
#endif
        xSemaphoreTake(wsMutex, portMAX_DELAY);
#ifdef ELATO_DIAGNOSTICS
        const uint32_t waited = millis() - waitingSince;
        recordMaximum(maxMutexMs, waited);
        mutexElapsedMs.fetch_add(waited, std::memory_order_relaxed);
#endif
        if (!shutdownInProgress && webSocket.isConnected() && deviceState == LISTENING) {
#ifdef ELATO_DIAGNOSTICS
            const uint32_t sendingSince = millis();
#endif
            const bool sent = webSocket.sendBIN(buffer, size);
#ifdef ELATO_DIAGNOSTICS
            const uint32_t elapsed = millis() - sendingSince;
            recordMaximum(maxSendMs, elapsed);
            sendElapsedMs.fetch_add(elapsed, std::memory_order_relaxed);
            if (sent) {
                micTxOk.fetch_add(1, std::memory_order_relaxed);
                micTxBytes.fetch_add(size, std::memory_order_relaxed);
            } else {
                micTxFailed.fetch_add(1, std::memory_order_relaxed);
            }
#else
            (void)sent;
#endif
        }
        xSemaphoreGive(wsMutex);
        return size;
    }
};

WebsocketStream wsStream; //guard with wsMutex
I2SStream i2sInput; //access from micTask only
static constexpr size_t MIC_SAMPLES_PER_BLOCK = 256; // 16 ms at 16 kHz.
const int MIC_COPY_SIZE = MIC_SAMPLES_PER_BLOCK * sizeof(int16_t);

// INMP441 supplies signed 24-bit samples left-aligned in 32-bit I2S slots.
// Keep the server's mono PCM16 format by taking each word's signed upper 16
// bits, without gain. This adapter retains no audio between reads, so draining
// raw I2S on idle/transition also discards all pending microphone audio.
class Inmp441Pcm16Stream : public AudioStream {
public:
    explicit Inmp441Pcm16Stream(I2SStream &input) : input(input) {}

    int available() override { return input.available() / 2; }

    size_t readBytes(uint8_t *data, size_t length) override {
        size_t count = length / sizeof(int16_t);
        if (count > MIC_SAMPLES_PER_BLOCK) count = MIC_SAMPLES_PER_BLOCK;
        if (count == 0) return 0;
#ifdef ELATO_DIAGNOSTICS
        const uint32_t readingSince = millis();
#endif
        const size_t bytesRead = input.readBytes(
            reinterpret_cast<uint8_t *>(samples), count * sizeof(int32_t));
#ifdef ELATO_DIAGNOSTICS
        recordMaximum(maxReadMs, millis() - readingSince);
#endif
        count = bytesRead / sizeof(int32_t);
        for (size_t i = 0; i < count; ++i) {
            const int16_t pcm = static_cast<int16_t>(samples[i] >> 16);
            std::memcpy(data + i * sizeof(pcm), &pcm, sizeof(pcm));
#ifdef ELATO_DIAGNOSTICS
            const uint32_t magnitude = pcm < 0 ? -static_cast<int32_t>(pcm) : pcm;
            micSum += pcm;
            micSquares += static_cast<int64_t>(pcm) * pcm;
            ++micSamples;
            if (magnitude > micPeak) micPeak = magnitude;
            if (magnitude >= 32760) ++micClipped;
#endif
        }
#ifdef ELATO_DIAGNOSTICS
        micBytes.fetch_add(count * sizeof(int16_t), std::memory_order_relaxed);
        if (micSamples && millis() - micReportMs >= 2000) {
            const double mean = static_cast<double>(micSum) / micSamples;
            const double variance = static_cast<double>(micSquares) / micSamples - mean * mean;
            Serial.printf("[MIC] ms=%lu samples=%lu ac_rms16=%.2f peak16=%lu clipped=%lu "
                          "capture_bytes=%lu\n", millis(), static_cast<unsigned long>(micSamples),
                          std::sqrt(variance > 0 ? variance : 0),
                          static_cast<unsigned long>(micPeak), static_cast<unsigned long>(micClipped),
                          static_cast<unsigned long>(micBytes.load(std::memory_order_relaxed)));
            micSum = 0; micSquares = 0; micSamples = 0; micPeak = 0; micClipped = 0;
            micReportMs = millis();
        }
#endif
        return count * sizeof(int16_t);
    }

private:
    I2SStream &input;
    int32_t samples[MIC_SAMPLES_PER_BLOCK]; // Global storage; not mic-task stack.
};

Inmp441Pcm16Stream micPcm16(i2sInput); //access from micTask only
StreamCopy micToWsCopier(wsStream, micPcm16, MIC_COPY_SIZE);
volatile bool i2sInputFlushScheduled = false;
size_t micDiscardLimit = 0;

// I2SStream::flush() is a no-op in the bundled audio-tools version. Drain RX
// with zero timeout so recorded speaker echo cannot survive a mic handoff.
void discardMicAudio() {
    uint8_t scratch[256];
    size_t discarded = 0;
    while (discarded < micDiscardLimit) {
        size_t bytesRead = 0;
        if (i2s_read(I2S_PORT_IN, scratch, sizeof(scratch), &bytesRead, 0) != ESP_OK ||
            bytesRead == 0) break;
        discarded += bytesRead;
    }
}

void micTask(void *parameter) {
    // Configure and start I2S input stream.
    auto i2sConfig = i2sInput.defaultConfig(RX_MODE);
    // INMP441 requires two 32-bit physical slots (64 SCK cycles per WS frame),
    // even when only its left channel is captured. PCM16 conversion is above.
    i2sConfig.bits_per_sample = 32;
    i2sConfig.sample_rate = MIC_SAMPLE_RATE;
    i2sConfig.channels = CHANNELS;
    i2sConfig.i2s_format = I2S_STD_FORMAT;
    i2sConfig.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    // Configure your I2S input pins appropriately here:
    i2sConfig.pin_bck = I2S_SCK;
    i2sConfig.pin_ws  = I2S_WS;
    i2sConfig.pin_data = I2S_SD;
    i2sConfig.port_no = I2S_PORT_IN;
    i2sConfig.buffer_count = 4;
    i2sConfig.buffer_size = 256;
    micDiscardLimit = i2sConfig.buffer_count * i2sConfig.buffer_size * 4;
    if (!i2sInput.begin(i2sConfig)) {
        Serial.println("[MIC] Unable to start INMP441 I2S input");
        vTaskDelete(NULL);
        return;
    }
    micPcm16.setAudioInfo(AudioInfo(MIC_SAMPLE_RATE, CHANNELS, BITS_PER_SAMPLE));
    Serial.println("[MIC] INMP441: 32-bit left slots, mono PCM16 at 16 kHz");

    micToWsCopier.setDelayOnNoData(0);

    while (1) {
        if (shutdownInProgress) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        if (i2sInputFlushScheduled) {
            i2sInputFlushScheduled = false;
            discardMicAudio();
        }

        if (deviceState == LISTENING && webSocket.isConnected()) {
            // At most 256 samples / 512 PCM16 bytes per WebSocket frame.
            micToWsCopier.copyBytes(MIC_COPY_SIZE);

            // Yield more frequently
            vTaskDelay(1);
        } else {
            discardMicAudio();
            vTaskDelay(10);
        }
    }
}

// WEBSOCKET EVENTS
// networkTask -> webSocket.loop() -> webSocketEvent()
void webSocketEvent(WStype_t type, const uint8_t *payload, size_t length)
{
    if (shutdownInProgress) return;
    switch (type)
    {
    case WStype_DISCONNECTED:
        Serial.printf("[WSc] Disconnected!\n");
        deviceState = IDLE;
        scheduleListeningRestart = false;
        activePlaybackId = pendingPlaybackId = 0;
        i2sOutputFlushScheduled = true;
        break;
    case WStype_CONNECTED:
        Serial.printf("[WSc] Connected to url: %s\n", payload);
        deviceState = PROCESSING;
        break;
    case WStype_TEXT:
    {
        Serial.printf("[WSc] get text: %s\n", payload);

        JsonDocument doc;
        DeserializationError error = deserializeJson(doc, (char *)payload);

        if (error)
        {
            Serial.println("Error deserializing JSON");
            deviceState = IDLE;
            return;
        }

        String type = doc["type"];

        // auth messages
        if (strcmp((char*)type.c_str(), "auth") == 0) {
            currentVolume = doc["volume_control"].as<int>();
            currentPitchFactor = doc["pitch_factor"].as<float>();

            bool is_ota = doc["is_ota"].as<bool>();
            bool is_reset = doc["is_reset"].as<bool>();

            // Update volumes on both streams
            volume.setVolume(currentVolume / 100.0f);
            volumePitch.setVolume(currentVolume / 100.0f);

            // Only initialize pitch shift if needed
            if (currentPitchFactor != 1.0f) {
                auto pcfg = pitchShift.defaultConfig();
                pcfg.copyFrom(info);
                pcfg.pitch_shift = currentPitchFactor;
                pcfg.buffer_size = 512;
                pitchShift.begin(pcfg);
            }

            if (is_ota) {
                Serial.println("OTA update received");
                setOTAStatusInNVS(OTA_IN_PROGRESS);
                ESP.restart();
            }

            if (is_reset) {
                Serial.println("Factory reset received");
                // setFactoryResetStatusInNVS(true);
                ESP.restart();
            }
        }

        // oai messages
        if (strcmp((char*)type.c_str(), "server") == 0) {
            String msg = doc["msg"];
            Serial.println(msg);

            if (msg == "AUDIO.CLEAR") {
                clearVoicePlayback();
                break;
            }
            if (strcmp((char*)msg.c_str(), "RESPONSE.COMPLETE") == 0 || strcmp((char*)msg.c_str(), "RESPONSE.ERROR") == 0) {
                // A playback_id means the server wants a handoff: finish playing the
                // queued audio, then ack with PLAYBACK.COMPLETE before listening.
                uint32_t playbackId = doc["playback_id"] | 0UL;
                if (msg == "RESPONSE.COMPLETE" && playbackId != 0) {
                    if (playbackId == activePlaybackId &&
                        (deviceState == SPEAKING || deviceState == LISTENING)) {
                        pendingPlaybackId = playbackId;
                        playbackDrainRequestedTime = millis();
                    }
                    break;
                }
                Serial.println("Received RESPONSE.COMPLETE or RESPONSE.ERROR, starting listening again");
                pendingPlaybackId = 0;

                // Check if volume_control is included in the message
                if (doc.containsKey("volume_control")) {
                    int newVolume = doc["volume_control"].as<int>();
                    volume.setVolume(newVolume / 100.0f);
                }

                scheduleListeningRestart = true;
                scheduledTime = millis() + 1000; // 1 second delay
            } else if (strcmp((char*)msg.c_str(), "AUDIO.COMMITTED") == 0) {
                deviceState = PROCESSING;
            } else if (strcmp((char*)msg.c_str(), "RESPONSE.CREATED") == 0) {
                Serial.println("Received RESPONSE.CREATED, transitioning to speaking");
                transitionToSpeaking();
                activePlaybackId = doc["playback_id"] | 0UL;
            } else if (strcmp((char*)msg.c_str(), "SESSION.END") == 0) {
                Serial.println("Received SESSION.END, going to sleep");
                sleepRequested = true;
            }
        }
    }
        break;
    case WStype_BIN:
    {
#ifdef ELATO_DIAGNOSTICS
        replyPackets.fetch_add(1, std::memory_order_relaxed);
        replyBytes.fetch_add(length, std::memory_order_relaxed);
        lastReplyMs.store(millis(), std::memory_order_relaxed);
#endif
        if (scheduleListeningRestart || deviceState != SPEAKING) {
            Serial.println("Skipping audio data due to touch interrupt.");
            break;
        }

        // Otherwise process the audio data normally
        size_t processed = opusDecoder.write(payload, length);
        if (processed != length) {
            Serial.printf("Warning: Only processed %d/%d bytes\n", processed, length);
        }
        break;
      }
    case WStype_ERROR:
        Serial.printf("[WSc] Error: %s\n", payload);
        break;
    case WStype_FRAGMENT_TEXT_START:
    case WStype_FRAGMENT_BIN_START:
    case WStype_FRAGMENT:
    case WStype_PONG:
    case WStype_PING:
    case WStype_FRAGMENT_FIN:
        break;
    }
}

// wifiTask -> WIFIMANAGER::loop() -> WIFIMANAGER::tryConnect() -> connectCb() -> websocketSetup()
void websocketSetup(const String& server_domain, int port, const String& path)
{
    if (shutdownInProgress) return;
    xSemaphoreTake(wsMutex, portMAX_DELAY);
    String targetHost = server_domain, targetPath = path, targetToken = authTokenGlobal;
#ifdef ELATO_MANAGEMENT
    // An opt-in managed device cannot silently connect using the legacy user token.
    if (!managementVoiceEndpoint(targetHost, port, targetPath, targetToken)) {
        xSemaphoreGive(wsMutex);
        return;
    }
#endif
    const String headers =
        "Authorization: Bearer " + targetToken + "\r\n" +
        "X-Wifi-Rssi: " + String(WiFi.RSSI()) + "\r\n" +
        "X-Elato-Playback-Ack: 1\r\n" +
        "X-Device-Mac: " + WiFi.macAddress();

    if (shutdownInProgress) {
        xSemaphoreGive(wsMutex);
        return;
    }

    webSocket.setExtraHeaders(headers.c_str());
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(1000);
    webSocket.disableHeartbeat();

    // webSocket.enableHeartbeat(30000, 15000, 3); // 30s ping interval, 15s timeout, 3 retries

    #if defined(DEV_MODE) && !defined(ELATO_MANAGEMENT)
    webSocket.begin(targetHost.c_str(), port, targetPath.c_str());
    #elif defined(ELATO_MANAGEMENT)
    webSocket.beginSslWithCA(targetHost.c_str(), port, targetPath.c_str(), managementTrustedRootCa());
    #else
    webSocket.beginSslWithCA(targetHost.c_str(), port, targetPath.c_str(), CA_cert);
    #endif

    xSemaphoreGive(wsMutex);
}

// networkTask -> webSocket.loop()
void networkTask(void *parameter) {
    while (1) {
        if (shutdownInProgress) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        xSemaphoreTake(wsMutex, portMAX_DELAY);
        if (shutdownInProgress) {
            xSemaphoreGive(wsMutex);
            continue;
        }

        // Check to see if a transition to listening mode is scheduled.
        if (scheduleListeningRestart && (long)(millis() - scheduledTime) >= 0) {
            transitionToListening();
        }

#ifdef ELATO_DIAGNOSTICS
        const uint32_t networkSince = millis();
#endif
        webSocket.loop();
#ifdef ELATO_DIAGNOSTICS
        recordMaximum(maxNetworkMs, millis() - networkSince);
#endif
        if (pendingPlaybackId != 0 &&
            (deviceState == SPEAKING || deviceState == LISTENING) &&
            !speakerCopyActive && audioBuffer.available() == 0 &&
            millis() - lastSpeakerWriteTime >= speakerDrainGuardMs &&
            millis() - playbackDrainRequestedTime >= speakerDrainGuardMs) {
            uint32_t completedId = pendingPlaybackId;
            // Turn the amp off and flush input before permitting mic frames.
            transitionToListening();
            JsonDocument ack;
            ack["type"] = "instruction";
            ack["msg"] = "PLAYBACK.COMPLETE";
            ack["playback_id"] = completedId;
            String text;
            serializeJson(ack, text);
            webSocket.sendTXT(text);
        }
        xSemaphoreGive(wsMutex);

        vTaskDelay(1);
    }
}
