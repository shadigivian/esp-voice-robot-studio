import { test, expect } from "@playwright/test";

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

for (const provider of ["qwen", "groq"] as const) {
  const label = provider === "groq" ? "Groq" : "Qwen";
  test(`${label} push-to-talk captures bounded PCM and plays the authenticated response`, async ({
    page,
    context,
  }) => {
    // Observe the real worklet without replacing its input or output. Browser
    // capture startup can lag the UI's recording state on a busy workstation.
    await page.addInitScript(() => {
      const measured = window as Window & {
        voiceCapture?: { frames: number; sampleRate: number };
      };
      const NativeAudioWorkletNode = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends NativeAudioWorkletNode {
        constructor(
          audioContext: BaseAudioContext,
          name: string,
          options?: AudioWorkletNodeOptions,
        ) {
          super(audioContext, name, options);
          if (name === "pcm-recorder") {
            const capture = { frames: 0, sampleRate: audioContext.sampleRate };
            measured.voiceCapture = capture;
            this.port.addEventListener("message", (event) => {
              capture.frames += event.data.length;
            });
            this.port.start();
          }
        }
      };
    });
    expect((await (await page.request.get("/api/auth")).json()).data.demo).toBe(
      true,
    );
    await page.goto("/login");
    await page
      .getByRole("button", { name: "ورود به محیط دمو", exact: true })
      .click();
    await expect(page).toHaveURL(/\/dashboard$/);
    const snapshot = (await (await page.request.get("/api/control")).json())
      .data;
    const deviceId = snapshot.devices[0].id;
    snapshot.demo = false;
    snapshot.integrations = {
      ...snapshot.integrations,
      provider,
      ai: "configured_not_tested",
      textModel:
        provider === "groq" ? "qwen/qwen3.8-27b" : "qwen3.8-omni-flash",
      model: provider === "groq" ? null : "qwen3.8-omni-flash-realtime",
      knowledge: "local_keyword",
      browserVoice: "push_to_talk",
      voiceSamples: true,
    };
    await page.route("**/api/control", async (route) => {
      if (route.request().method() === "GET")
        await route.fulfill({ json: { data: snapshot } });
      else await route.continue();
    });
    let submitted = false;
    await page.route("**/api/voice", async (route) => {
      const body = route.request().postDataJSON();
      expect(body.action).toBe(provider === "groq" ? "groq_turn" : "qwen_turn");
      expect(body.deviceId).toBe(deviceId);
      const pcm = Buffer.from(body.audio, "base64");
      expect(pcm.length).toBeGreaterThanOrEqual(3200);
      expect(pcm.length).toBeLessThanOrEqual(480000);
      expect(pcm.length % 2).toBe(0);
      submitted = true;
      const header = Buffer.alloc(44);
      header.write("RIFF");
      header.writeUInt32LE(516, 4);
      header.write("WAVEfmt ", 8);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(24000, 24);
      header.writeUInt32LE(48000, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write("data", 36);
      header.writeUInt32LE(480, 40);
      await route.fulfill({
        json: {
          data: {
            audio: Buffer.concat([header, Buffer.alloc(480)]).toString(
              "base64",
            ),
            transcript: `پاسخ آزمایشی ${label}`,
            sessionId: "fixture-turn",
          },
        },
      });
    });
    await context.grantPermissions(["microphone"]);
    await page.goto(`/devices/${deviceId}/playground`);
    await page
      .getByRole("button", { name: "آزمایش صوتی", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: `آزمایش صوتی ${label}` }),
    ).toBeVisible();
    await page.getByRole("button", { name: "شروع ضبط", exact: true }).click();
    const stop = page.getByRole("button", {
      name: "پایان ضبط و ارسال",
      exact: true,
    });
    await expect(stop).toBeVisible();
    // Wait for measured microphone samples, not an assumed wall-clock delay.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const capture = (
            window as Window & {
              voiceCapture?: { frames: number; sampleRate: number };
            }
          ).voiceCapture;
          return capture ? capture.frames / capture.sampleRate : 0;
        }),
      )
      .toBeGreaterThanOrEqual(0.2);
    await stop.click();
    await expect(
      page.getByText(`پاسخ آزمایشی ${label}`, { exact: true }),
    ).toBeVisible();
    expect(submitted).toBe(true);
    await expect(page.locator(".voice-playground audio")).toHaveAttribute(
      "src",
      /^blob:/,
    );
    await expect(
      page.getByRole("button", { name: "شروع ضبط", exact: true }),
    ).toBeEnabled();
  });
}
