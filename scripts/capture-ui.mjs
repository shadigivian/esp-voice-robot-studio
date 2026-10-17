import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const phase = process.argv[2] || "after";
const output = path.resolve(".local/ui", phase);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const origin = "http://127.0.0.1:3100";
  const mode = await page.request.get(`${origin}/api/auth`);
  if (!(await mode.json()).data.demo)
    throw new Error("UI capture requires an explicitly started demo.");
  await page.goto(`${origin}/login`);
  await page
    .getByRole("button", { name: "ورود به محیط دمو", exact: true })
    .click();
  await page.waitForURL("**/dashboard");
  const state = (await (await page.request.get(`${origin}/api/control`)).json())
    .data;
  const id = state.devices[0].id;
  const metrics = [];
  for (const [name, route, mobile] of [
    ["dashboard", "/dashboard", false],
    ["devices", "/devices", false],
    ["settings", `/devices/${id}/settings`, false],
    ["settings-mobile", `/devices/${id}/settings`, true],
    ["devices-mobile", "/devices", true],
  ]) {
    await page.setViewportSize(
      mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    );
    await page.goto(origin + route);
    await page.locator("#main-content h1").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(output, `${name}.png`),
      fullPage: true,
    });
    await page.screenshot({ path: path.join(output, `${name}-viewport.png`) });
    metrics.push({
      name,
      ...(await page.evaluate(() => ({
        width: innerWidth,
        pageWidth: document.documentElement.scrollWidth,
        heading: document.querySelector("h1")?.textContent,
        labelSize: document.querySelector(".field > span")
          ? getComputedStyle(document.querySelector(".field > span")).fontSize
          : null,
      }))),
    });
  }
  await writeFile(
    path.join(output, "metrics.json"),
    JSON.stringify({ metrics, errors }, null, 2),
  );
  console.log(JSON.stringify({ output, metrics, errors }, null, 2));
} finally {
  await browser.close();
}
