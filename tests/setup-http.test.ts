import test from "node:test";
import assert from "node:assert/strict";

const base = process.env.TEST_SETUP_BASE_URL;
test(
  "HTTP: unconfigured production reports setup and never enters demo",
  {
    skip: !base
      ? "Set TEST_SETUP_BASE_URL to an explicitly unconfigured local production server."
      : false,
  },
  async () => {
    const origin = new URL(base!).origin;
    const auth = await fetch(`${origin}/api/auth`);
    const mode = (await auth.json()).data;
    assert.equal(mode.demo, false);
    assert.equal(mode.configured, false);
    const control = await fetch(`${origin}/api/control`);
    assert.equal(control.status, 503);
    assert.equal((await control.json()).error.code, "SETUP_REQUIRED");
    const login = await fetch(`${origin}/api/auth`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ demo: true }),
    });
    assert.equal(login.status, 503);
    assert.equal((await login.json()).error.code, "SETUP_REQUIRED");
    assert.equal(login.headers.get("set-cookie"), null);
    for (const route of [
      "/login",
      "/dashboard",
      "/devices",
      "/characters",
      "/settings/integrations",
    ]) {
      const page = await fetch(`${origin}${route}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<html[^>]*lang="fa"[^>]*dir="rtl"/);
      assert.equal(page.headers.get("x-content-type-options"), "nosniff");
      assert.equal(page.headers.get("x-frame-options"), "DENY");
    }
  },
);
