import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = path.resolve(".local/ui/reference");
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  let navigationError = null;
  try {
    await page.goto("https://www.elatoai.com/home/settings/device", {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
  } catch (error) {
    navigationError = error.message.split("\n")[0];
  }
  await page.screenshot({
    path: path.join(directory, "elato-device.png"),
    fullPage: true,
  });
  const details = {
    url: page.url(),
    title: await page.title(),
    navigationError,
    headings: await page.getByRole("heading").allTextContents(),
    text: (await page.locator("body").innerText()).slice(0, 3000),
  };
  await writeFile(
    path.join(directory, "inspection.json"),
    JSON.stringify(details, null, 2),
  );
  console.log(JSON.stringify(details, null, 2));
} finally {
  await browser.close();
}
