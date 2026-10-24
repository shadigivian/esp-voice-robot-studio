"use client";

import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square } from "lucide-react";

export default function QwenVoicePlayground({
  deviceId,
  mode,
  ready,
  l,
  request,
  refresh,
}: {
  deviceId: string;
  mode: "draft" | "published";
  ready: boolean;
  l: (fa: string, en: string) => string;
  request: (url: string, init?: RequestInit) => Promise<Response>;
  refresh: () => Promise<void>;
}) {
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [url, setUrl] = useState("");
  const capture = useRef<{
    context: AudioContext;
    stream: MediaStream;
    chunks: Float32Array[];
    node: AudioWorkletNode;
    source: MediaStreamAudioSourceNode;
    frames: number;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const currentUrl = useRef("");
  const player = useRef<HTMLAudioElement>(null);
  function releaseCapture() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const value = capture.current;
    capture.current = null;
    if (value) {
      value.node.port.onmessage = null;
      value.node.disconnect();
      value.source.disconnect();
      value.stream.getTracks().forEach((track) => track.stop());
      void value.context.close();
    }
    return value;
  }
  function cancel() {
    generation.current++;
    busy.current = false;
    releaseCapture();
    controller.current?.abort();
    controller.current = null;
    player.current?.pause();
    setPhase("idle");
  }
  useEffect(
    () => () => {
      generation.current++;
      busy.current = false;
      releaseCapture();
      controller.current?.abort();
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
    },
    [deviceId, mode],
  );
  async function submit() {
    const recording = releaseCapture();
    if (!recording) return;
    const ownGeneration = generation.current;
    setPhase("processing");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const samples = new Float32Array(recording.frames);
      let offset = 0;
      for (const chunk of recording.chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }
      const ratio = recording.context.sampleRate / 16000;
      const length = Math.min(240000, Math.floor(samples.length / ratio));
      const pcm = new Uint8Array(length * 2);
      const view = new DataView(pcm.buffer);
      for (let i = 0; i < length; i++) {
        // Average the source interval when downsampling to suppress aliasing.
        const first = Math.floor(i * ratio),
          last = Math.min(
            samples.length,
            Math.max(first + 1, Math.floor((i + 1) * ratio)),
          );
        let sum = 0;
        for (let j = first; j < last; j++) sum += samples[j];
        const value = Math.max(-1, Math.min(1, sum / (last - first)));
        view.setInt16(i * 2, value * (value < 0 ? 32768 : 32767), true);
      }
      if (length < 1600)
        throw new Error(
          l("حداقل یک لحظه صحبت کنید.", "Record at least a short phrase."),
        );
      let binary = "";
      for (let i = 0; i < pcm.length; i += 8192)
        binary += String.fromCharCode(...pcm.subarray(i, i + 8192));
      const response = await request("/api/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "qwen_turn",
          deviceId,
          preview: mode,
          audio: btoa(binary),
        }),
        signal: abort.signal,
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error?.message ||
            body.error ||
            l("آزمایش صوتی ناموفق بود.", "Voice test failed."),
        );
      if (ownGeneration !== generation.current) return;
      const bytes = Uint8Array.from(atob(body.data.audio), (character) =>
        character.charCodeAt(0),
      );
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = URL.createObjectURL(
        new Blob([bytes], { type: "audio/wav" }),
      );
      setUrl(currentUrl.current);
      setTranscript(body.data.transcript || "");
      setPhase("idle");
      await refresh();
    } catch (err) {
      if (ownGeneration === generation.current) {
        setError(err instanceof Error ? err.message : "Voice test failed");
        setPhase("idle");
      }
    } finally {
      if (ownGeneration === generation.current) {
        busy.current = false;
        controller.current = null;
      }
    }
  }
  async function start() {
    if (busy.current) return;
    busy.current = true;
    setPhase("starting");
    setError("");
    setTranscript("");
    player.current?.pause();
    const ownGeneration = ++generation.current;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (ownGeneration !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      context = new AudioContext();
      await context.audioWorklet.addModule("/pcm-recorder.js");
      await context.resume();
      if (ownGeneration !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        await context.close();
        return;
      }
      const node = new AudioWorkletNode(context, "pcm-recorder");
      const source = context.createMediaStreamSource(stream);
      const recording = {
        context,
        stream,
        node,
        source,
        chunks: [] as Float32Array[],
        frames: 0,
      };
      capture.current = recording;
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (
          capture.current !== recording ||
          recording.frames >= context!.sampleRate * 15
        )
          return;
        recording.chunks.push(event.data);
        recording.frames += event.data.length;
      };
      const silence = context.createGain();
      silence.gain.value = 0;
      source.connect(node);
      node.connect(silence);
      silence.connect(context.destination);
      timer.current = setTimeout(() => void submit(), 15000);
      setPhase("recording");
    } catch (err) {
      stream?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") await context.close();
      if (ownGeneration === generation.current) {
        busy.current = false;
        setPhase("idle");
        setError(err instanceof Error ? err.message : "Microphone unavailable");
      }
    }
  }
  return (
    <div className="voice-playground">
      <span className={`voice-orb ${phase === "recording" ? "connected" : ""}`}>
        <Mic size={35} />
      </span>
      <h3>{l("آزمایش صوتی Qwen", "Qwen voice test")}</h3>
      <p>
        {l(
          "برای ضبط کلیک کنید و پس از صحبت، ارسال را بزنید. ضبط حداکثر ۱۵ ثانیه است و پاسخ بعد از پردازش پخش می‌شود. هر ضبط یک جلسهٔ تازه است. این آزمایش ممکن است مصرف API داشته باشد.",
          "Click to record, then send when you finish speaking. Recording stops at 15 seconds; the response plays after processing. Each recording starts a fresh session. This test may incur API usage.",
        )}
      </p>
      {!ready && (
        <p>
          {l(
            "کلید و مدل Qwen را روی سرور تنظیم کنید.",
            "Configure the Qwen key and model on the server.",
          )}
        </p>
      )}
      <div className="voice-buttons">
        {phase === "idle" ? (
          <button
            type="button"
            className="button primary"
            disabled={!ready}
            onClick={() => void start()}
          >
            <Mic size={16} />
            {l("شروع ضبط", "Start recording")}
          </button>
        ) : (
          <>
            {phase === "recording" ? (
              <button
                type="button"
                className="button primary"
                onClick={() => void submit()}
              >
                <Square size={16} />
                {l("پایان ضبط و ارسال", "Stop and send")}
              </button>
            ) : (
              <span>
                <LoaderCircle size={16} className="spin" />
                {phase === "starting"
                  ? l("آماده‌سازی میکروفون", "Preparing microphone")
                  : l("در حال پردازش", "Processing")}
              </span>
            )}
            <button type="button" className="button secondary" onClick={cancel}>
              {l("لغو", "Cancel")}
            </button>
          </>
        )}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <audio
        ref={player}
        src={url || undefined}
        controls={!!url}
        autoPlay
        aria-label={l("پاسخ صوتی Qwen", "Qwen audio response")}
      />
      {transcript && <p>{transcript}</p>}
    </div>
  );
}
