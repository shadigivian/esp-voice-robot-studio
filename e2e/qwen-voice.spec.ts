import { test, expect } from "@playwright/test";

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
});

test("Qwen push-to-talk captures bounded PCM and plays the authenticated response", async ({
  page,
  context,
}) => {
  expect((await (await page.request.get("/api/auth")).json()).data.demo).toBe(
    true,
  );
  await page.goto("/login");
  await page
    .getByRole("button", { name: "ورود به محیط دمو", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const snapshot = (await (await page.request.get("/api/control")).json()).data;
  const deviceId = snapshot.devices[0].id;
  snapshot.demo = false;
  snapshot.integrations = {
    ...snapshot.integrations,
    provider: "qwen",
    ai: "configured_not_tested",
    model: "qwen3.8-omni-flash-realtime",
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
    expect(body.action).toBe("qwen_turn");
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
          audio: Buffer.concat([header, Buffer.alloc(480)]).toString("base64"),
          transcript: "پاسخ آزمایشی Qwen",
          sessionId: "fixture-turn",
        },
      },
    });
  });
  await context.grantPermissions(["microphone"]);
  await page.goto(`/devices/${deviceId}/playground`);
  await page.getByRole("button", { name: "آزمایش صوتی", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "آزمایش صوتی Qwen" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "شروع ضبط", exact: true }).click();
  const stop = page.getByRole("button", {
    name: "پایان ضبط و ارسال",
    exact: true,
  });
  await expect(stop).toBeVisible();
  // Real AudioWorklet input must accumulate before submitting the short fixture turn.
  await expect
    .poll(() =>
      page.evaluate(() => !!document.querySelector(".voice-orb.connected")),
    )
    .toBe(true);
  await page.waitForTimeout(250);
  await stop.click();
  await expect(
    page.getByText("پاسخ آزمایشی Qwen", { exact: true }),
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
