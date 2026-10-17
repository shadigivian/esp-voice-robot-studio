import { test, expect, type Page } from "@playwright/test";

async function enterDemo(page: Page) {
  const response = await page.request.get("/api/auth");
  expect(
    (await response.json()).data.demo,
    "UI tests must use an explicitly isolated demo.",
  ).toBe(true);
  await page.goto("/login");
  await page
    .getByRole("button", { name: "ورود به محیط دمو", exact: true })
    .click();
  await expect(page).toHaveURL(/\/dashboard$/);
  const state = (await (await page.request.get("/api/control")).json()).data;
  return state.devices[0].id as string;
}
async function hasNoPageOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}

test("settings save actual data, show pending edits, and protect unsaved navigation", async ({
  page,
}) => {
  const id = await enterDemo(page);
  await page.goto(`/devices/${id}/settings`);
  const name = page.getByLabel("نام نمایشی ربات", { exact: true });
  await expect(name).toBeVisible();
  const save = page.getByRole("button", { name: "ذخیره نام", exact: true });
  await expect(save).toBeDisabled();
  await name.fill("ربات پذیرش آزمایشی");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await expect(page.locator(".device-heading h1")).toHaveText(
    "ربات پذیرش آزمایشی",
  );
  await name.fill("تغییر ذخیره نشده");
  await page
    .locator(".main-nav")
    .getByRole("link", { name: /^دستگاه‌های من/ })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "تغییرات ذخیره‌نشده",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "ماندن در صفحه", exact: true })
    .click();
  await expect(name).toHaveValue("تغییر ذخیره نشده");
  await expect(page).toHaveURL(new RegExp(`/devices/${id}/settings$`));
  await page
    .locator(".main-nav")
    .getByRole("link", { name: /^دستگاه‌های من/ })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "خروج بدون ذخیره", exact: true })
    .click();
  await expect(page).toHaveURL(/\/devices$/);
  const state = (await (await page.request.get("/api/control")).json()).data;
  expect(
    state.devices.find((device: { id: string }) => device.id === id).name,
  ).toBe("ربات پذیرش آزمایشی");
});

test("privacy switch is accessible and persists, unavailable hardware stays disabled", async ({
  page,
}) => {
  const id = await enterDemo(page);
  await page.goto(`/devices/${id}/settings`);
  const toggle = page.getByRole("switch", {
    name: "ذخیره متن مکالمه",
    exact: true,
  });
  await expect(toggle).not.toBeChecked();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toBeChecked();
  await page
    .getByRole("button", { name: "ذخیره حریم خصوصی", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "ذخیره متن مکالمه", exact: true }),
  ).toBeChecked();
  await expect(
    page.locator("#device-audio").getByRole("slider"),
  ).toBeDisabled();
  await expect(
    page
      .locator("#device-audio")
      .getByRole("button", { name: /ارسال/ })
      .first(),
  ).toBeDisabled();
  const refresh = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/control") &&
      response.request().method() === "GET",
  );
  await page
    .getByRole("button", { name: "به‌روزرسانی وضعیت", exact: true })
    .click();
  expect((await refresh).ok()).toBe(true);
  await hasNoPageOverflow(page);
});

test("mobile has readable forms, visible current device tab and usable bottom navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await enterDemo(page);
  await page.goto(`/devices/${id}/settings`);
  await expect(page.locator("#workspace-sidebar")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  const menuToggle = page.getByRole("button", {
    name: "بازکردن منو",
    exact: true,
  });
  await menuToggle.click();
  const navigation = page.getByRole("dialog", {
    name: "منوی اصلی",
    exact: true,
  });
  await expect(navigation).toBeVisible();
  await page.keyboard.press("Tab");
  expect(
    await navigation.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(navigation).toHaveCount(0);
  await expect(menuToggle).toBeFocused();
  await expect(
    page.locator('.device-tabs [aria-current="page"]'),
  ).toBeVisible();
  await expect(page.locator(".mobile-bottom-nav")).toBeVisible();
  await expect(
    page.getByLabel("نام نمایشی ربات", { exact: true }),
  ).toBeVisible();
  const sizes = await page
    .getByLabel("نام نمایشی ربات", { exact: true })
    .evaluate((element) => ({
      font: parseFloat(getComputedStyle(element).fontSize),
      height: element.getBoundingClientRect().height,
    }));
  expect(sizes.font).toBeGreaterThanOrEqual(14);
  expect(sizes.height).toBeGreaterThanOrEqual(44);
  const revoke = page
    .locator("#device-lifecycle")
    .getByRole("button", { name: /لغو/ });
  await revoke.scrollIntoViewIfNeeded();
  const revokeBox = await revoke.boundingBox();
  const navBox = await page.locator(".mobile-bottom-nav").boundingBox();
  expect(revokeBox!.y + revokeBox!.height).toBeLessThanOrEqual(navBox!.y);
  await hasNoPageOverflow(page);
  await page
    .getByLabel("نام نمایشی ربات", { exact: true })
    .fill("تغییر موبایل");
  await menuToggle.click();
  await page
    .locator("#workspace-sidebar .main-nav")
    .getByRole("link", { name: /^دستگاه‌های من/ })
    .click();
  const unsaved = page.getByRole("dialog", {
    name: "تغییرات ذخیره‌نشده",
    exact: true,
  });
  await expect(unsaved).toBeVisible();
  await unsaved
    .getByRole("button", { name: "ماندن در صفحه", exact: true })
    .click();
  await expect(page.getByLabel("نام نمایشی ربات", { exact: true })).toHaveValue(
    "تغییر موبایل",
  );
  // Restore the saved value so the next navigation requires no confirmation.
  await page
    .getByLabel("نام نمایشی ربات", { exact: true })
    .fill("آوا · راهنمای رستوران");
  await page
    .locator(".mobile-bottom-nav")
    .getByRole("link", { name: "دستگاه‌های من", exact: true })
    .click();
  await expect(page).toHaveURL(/\/devices$/);
  await hasNoPageOverflow(page);
});

test("English, dark theme and keyboard confirmation retain navigation and focus", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const id = await enterDemo(page);
  await page
    .getByRole("button", { name: "تغییر زبان به انگلیسی", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.goto(`/devices/${id}/settings`);
  await expect(
    page.getByLabel("Robot display name", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page
    .locator("#device-lifecycle")
    .getByRole("button", { name: /Revoke/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab");
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await hasNoPageOverflow(page);
  expect(errors).toEqual([]);
});

test("an older status response cannot overwrite a newly saved device name", async ({
  page,
}) => {
  const id = await enterDemo(page);
  await page.goto(`/devices/${id}/settings`);
  const name = page.getByLabel("نام نمایشی ربات", { exact: true });
  await expect(name).toBeVisible();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let reads = 0;
  await page.route("**/api/control", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    reads += 1;
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  try {
    const refresh = page.getByRole("button", {
      name: "به‌روزرسانی وضعیت",
      exact: true,
    });
    await refresh.click();
    await pending;
    await refresh.click();
    expect(reads).toBe(1);
    await name.fill("نام ذخیره‌شده تازه");
    await page.getByRole("button", { name: "ذخیره نام", exact: true }).click();
    await expect(page.locator(".device-heading h1")).toHaveText(
      "نام ذخیره‌شده تازه",
    );
    const stale = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/control") &&
        response.request().method() === "GET",
    );
    release();
    await (await stale).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(name).toHaveValue("نام ذخیره‌شده تازه");
    await expect(page.locator(".device-heading h1")).toHaveText(
      "نام ذخیره‌شده تازه",
    );
  } finally {
    release();
    await page.unroute("**/api/control");
  }
});
