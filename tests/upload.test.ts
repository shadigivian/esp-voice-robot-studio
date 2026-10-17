import test from "node:test";
import assert from "node:assert/strict";
import { extractFile, safeFilename } from "../lib/extract";
import { AppError } from "../lib/server/errors";
import { checkOrigin, jsonBody } from "../lib/http";
import { createHash } from "node:crypto";

function rc4(key: Buffer, bytes: Buffer) {
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  let i = 0;
  j = 0;
  return Buffer.from(
    bytes.map((byte) => {
      i = (i + 1) & 255;
      j = (j + state[i]) & 255;
      [state[i], state[j]] = [state[j], state[i]];
      return byte ^ state[(state[i] + state[j]) & 255];
    }),
  );
}
function encryptedPdfFixture() {
  // Real Standard Security Handler revision 2 password fixture, never user data.
  const padding = Buffer.from(
    "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
    "hex",
  );
  const pad = (password: string) =>
    Buffer.concat([Buffer.from(password), padding]).subarray(0, 32);
  const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest();
  const owner = rc4(
    md5(pad("fixture-owner")).subarray(0, 5),
    pad("fixture-password"),
  );
  const fileId = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-4);
  const key = md5(
    Buffer.concat([pad("fixture-password"), owner, permissions, fileId]),
  ).subarray(0, 5);
  const user = rc4(key, padding);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R /ID [<${fileId.toString("hex")}> <${fileId.toString("hex")}>] >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf));
}

function pdfFixture(content: string, toUnicode = "") {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${toUnicode ? "/ToUnicode 6 0 R" : ""} >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ...(toUnicode
      ? [`<< /Length ${toUnicode.length} >>\nstream\n${toUnicode}\nendstream`]
      : []),
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf));
}
test("UTF-8 Persian and mixed Markdown retain real content", async () => {
  const text = "# راهنما\nساعت کاری: ۹ تا ۱۷\nEnglish reference: ABC-123";
  const result = await extractFile(
    new TextEncoder().encode(text),
    "guide.md",
    "text/markdown",
  );
  assert.equal(result.text, text);
  assert.equal(safeFilename("../..\\unsafe\nname.pdf"), "unsafename.pdf");
});
test("upload validates signature, binary content, UTF-8 and size", async () => {
  await assert.rejects(
    extractFile(
      new TextEncoder().encode("not PDF"),
      "fake.pdf",
      "application/pdf",
    ),
    { code: "FILE_SIGNATURE" },
  );
  await assert.rejects(
    extractFile(new Uint8Array([65, 0, 66]), "binary.txt", "text/plain"),
    { code: "BINARY_FILE" },
  );
  await assert.rejects(
    extractFile(new Uint8Array([0xff, 0xfe]), "bad.txt", "text/plain"),
    { code: "TEXT_ENCODING" },
  );
  await assert.rejects(
    extractFile(new Uint8Array(), "empty.md", "text/markdown"),
    { code: "UPLOAD_LIMIT" },
  );
  await assert.rejects(
    extractFile(
      new TextEncoder().encode("x"),
      "x.exe",
      "application/octet-stream",
    ),
    { code: "FILE_TYPE" },
  );
});
test("text PDF parses in bounded worker; image-only and invalid PDF never produce invented text", async () => {
  const text = await extractFile(
    pdfFixture(
      "BT /F1 12 Tf 10 100 Td (Verified opening hours: 9 to 17) Tj ET",
    ),
    "text.pdf",
    "application/pdf",
  );
  assert.match(text.text, /Verified opening hours: 9 to 17/);
  assert.equal(text.pages, 1);
  assert.equal(text.needsReview, false);
  const scan = await extractFile(pdfFixture(""), "scan.pdf", "application/pdf");
  assert.equal(scan.text, "");
  assert.equal(scan.needsReview, true);
  assert.match(scan.warning!, /OCR is not configured/);
  await assert.rejects(
    extractFile(
      new TextEncoder().encode("%PDF-1.7\ninvalid"),
      "broken.pdf",
      "application/pdf",
    ),
    { code: "PDF_UNREADABLE" },
  );
});
test("mixed-script PDF extracts Persian through a real Unicode font map", async () => {
  const cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Test def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n4 beginbfchar\n<01> <0645>\n<02> <0627>\n<03> <0644>\n<04> <0633>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
  const result = await extractFile(
    pdfFixture("BT /F1 12 Tf 10 100 Td (English ) Tj <01020304> Tj ET", cmap),
    "mixed.pdf",
    "application/pdf",
  );
  assert.match(result.text, /سلام/);
  assert.match(result.text, /English/);
});
test("encrypted, too many pages, oversized and timed-out inputs have explicit failures", async () => {
  await assert.rejects(
    extractFile(encryptedPdfFixture(), "encrypted.pdf", "application/pdf"),
    { code: "PDF_ENCRYPTED" },
  );
  const previous = {
    pages: process.env.MAX_PDF_PAGES,
    timeout: process.env.PDF_PARSE_TIMEOUT_MS,
    bytes: process.env.MAX_UPLOAD_BYTES,
  };
  try {
    process.env.MAX_PDF_PAGES = "0";
    await assert.rejects(
      extractFile(pdfFixture(""), "large.pdf", "application/pdf"),
      { code: "PDF_PAGE_LIMIT" },
    );
    delete process.env.MAX_PDF_PAGES;
    process.env.PDF_PARSE_TIMEOUT_MS = "1";
    await assert.rejects(
      extractFile(pdfFixture(""), "slow.pdf", "application/pdf"),
      { code: "PDF_TIMEOUT" },
    );
    process.env.MAX_UPLOAD_BYTES = "5";
    await assert.rejects(
      extractFile(
        new TextEncoder().encode("123456"),
        "large.txt",
        "text/plain",
      ),
      { code: "UPLOAD_LIMIT" },
    );
  } finally {
    for (const [name, value] of Object.entries({
      MAX_PDF_PAGES: previous.pages,
      PDF_PARSE_TIMEOUT_MS: previous.timeout,
      MAX_UPLOAD_BYTES: previous.bytes,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
test("browser mutation origin and JSON streaming limits are enforced", async () => {
  const previous = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "https://panel.example";
  try {
    assert.throws(
      () =>
        checkOrigin(
          new Request("https://panel.example/api/control", {
            headers: { origin: "https://evil.example", cookie: "x=y" },
          }),
        ),
      AppError,
    );
    assert.throws(
      () =>
        checkOrigin(
          new Request("https://panel.example/api/control", {
            headers: { cookie: "x=y" },
          }),
        ),
      { code: "ORIGIN_REQUIRED" },
    );
    checkOrigin(
      new Request("https://panel.example/api/control", {
        headers: { origin: "https://panel.example" },
      }),
    );
    await assert.rejects(
      jsonBody(
        new Request("https://panel.example", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "x".repeat(100) }),
        }),
        20,
      ),
      { code: "BODY_TOO_LARGE" },
    );
  } finally {
    if (previous === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous;
  }
});
