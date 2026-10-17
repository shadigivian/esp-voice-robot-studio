import { Worker } from "node:worker_threads";
import path from "node:path";
import { AppError } from "./server/errors";

export interface Extraction {
  text: string;
  pages?: number;
  needsReview?: boolean;
  warning?: string | null;
}
export const uploadLimit = () =>
  Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024);
export function safeFilename(name: string) {
  return (
    Array.from(path.basename(name.replace(/\\/g, "/")))
      .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
      .join("")
      .slice(0, 160) || "document"
  );
}
export async function extractFile(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<Extraction> {
  if (!bytes.length || bytes.length > uploadLimit())
    throw new AppError(
      "UPLOAD_LIMIT",
      "The document is empty or exceeds the upload limit.",
      413,
    );
  const extension = path.extname(filename).toLowerCase();
  const maxCharacters = Number(process.env.MAX_DOCUMENT_CHARACTERS || 500_000);
  if (extension === ".pdf") {
    if (
      mime !== "application/pdf" ||
      Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-"
    )
      throw new AppError(
        "FILE_SIGNATURE",
        "The PDF type and signature must match.",
        415,
      );
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        path.join(process.cwd(), "lib", "parsers", "pdf-worker.mjs"),
        {
          workerData: {
            bytes,
            maxPages: Number(process.env.MAX_PDF_PAGES || 100),
            maxCharacters,
          },
          resourceLimits: {
            maxOldGenerationSizeMb: 192,
            maxYoungGenerationSizeMb: 32,
          },
        },
      );
      let settled = false;
      const finish = (error?: Error, result?: Extraction) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        if (error) reject(error);
        else resolve(result!);
      };
      const timer = setTimeout(
        () =>
          finish(
            new AppError(
              "PDF_TIMEOUT",
              "PDF extraction timed out. Supply plain text or a smaller file.",
              422,
            ),
          ),
        Number(process.env.PDF_PARSE_TIMEOUT_MS || 15_000),
      );
      worker.once("message", (result) =>
        result.error
          ? finish(
              new AppError(
                result.error,
                "This PDF could not be extracted. Encrypted, invalid or oversized documents need replacement text.",
                422,
              ),
            )
          : finish(undefined, result),
      );
      worker.once("error", () =>
        finish(
          new AppError(
            "PDF_PARSER_ERROR",
            "PDF extraction failed. Supply replacement text.",
            422,
          ),
        ),
      );
      worker.once("exit", (code) => {
        if (!settled)
          finish(
            new AppError(
              "PDF_PARSER_ERROR",
              `PDF parser stopped (${code}).`,
              422,
            ),
          );
      });
    });
  }
  if (
    ![".txt", ".md", ".markdown"].includes(extension) ||
    ![
      "text/plain",
      "text/markdown",
      "text/x-markdown",
      "application/octet-stream",
      "",
    ].includes(mime)
  )
    throw new AppError(
      "FILE_TYPE",
      "Supported uploads: PDF, UTF-8 TXT and Markdown.",
      415,
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AppError("TEXT_ENCODING", "Text files must use UTF-8.", 422);
  }
  if (
    Array.from(text).some(
      (char) => char.charCodeAt(0) < 32 && !["\t", "\n", "\r"].includes(char),
    )
  )
    throw new AppError(
      "BINARY_FILE",
      "A binary file cannot be uploaded as text.",
      415,
    );
  if (!text.trim() || text.length > maxCharacters)
    throw new AppError(
      "TEXT_LIMIT",
      "Text is empty or exceeds the document limit.",
      422,
    );
  return { text: text.normalize("NFC") };
}
