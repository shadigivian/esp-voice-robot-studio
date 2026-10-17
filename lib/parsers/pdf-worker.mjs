import { parentPort, workerData } from "node:worker_threads";

// A disposable worker bounds parsing time and memory independently of voice I/O.
let document;
try {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  document = await getDocument({
    data: new Uint8Array(workerData.bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
    stopAtErrors: true,
  }).promise;
  if (document.numPages > workerData.maxPages) throw new Error("PAGE_LIMIT");
  const pages = [];
  let count = 0;
  let imageOnly = false;
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item) => "str" in item)
      .map((item) => item.str + (item.hasEOL ? "\n" : " "))
      .join("")
      .trim();
    if (!text || !/[\p{L}\p{N}]/u.test(text)) imageOnly = true;
    count += text.length;
    if (count > workerData.maxCharacters) throw new Error("TEXT_LIMIT");
    pages.push(text);
    page.cleanup();
  }
  parentPort.postMessage({
    text: pages.join("\n\n"),
    pages: document.numPages,
    needsReview: imageOnly,
    warning: imageOnly
      ? "Some pages have no extractable text. OCR is not configured; supply and approve replacement text."
      : null,
  });
} catch (error) {
  const name = error?.name || "";
  const message = error?.message || "";
  const code =
    name === "PasswordException"
      ? "PDF_ENCRYPTED"
      : message === "PAGE_LIMIT"
        ? "PDF_PAGE_LIMIT"
        : message === "TEXT_LIMIT"
          ? "TEXT_LIMIT"
          : "PDF_UNREADABLE";
  parentPort.postMessage({ error: code });
} finally {
  if (document) await document.destroy();
}
