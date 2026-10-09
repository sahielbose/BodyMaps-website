import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";

// What the status line says when an upload fails: what went wrong and what to
// do, in plain words. Content types, HTTP codes and the HTML a proxy sends
// while the server restarts go to the console, never to the page.

const CHUNK_SIZE = 512 * 1024;
const USER = { id: "u1", email: "one@example.com", name: null, plan: "pro" };

const json = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: () => "application/json" },
});
const html = (status: number) => ({
  ok: false,
  status,
  json: async () => {
    throw new SyntaxError("Unexpected token <");
  },
  text: async () => "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>",
  headers: { get: () => "text/html" },
});

/** How the upload endpoints answer in the current test. */
let chunkReply: () => unknown;
let sliceReply: () => unknown;

beforeEach(() => {
  chunkReply = () => json({ ok: true });
  sliceReply = () => json({ ok: true });
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/upload-inference-chunk")) return chunkReply();
    if (u.includes("/api/upload-dicom-slice")) return sliceReply();
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "ct.nii.gz" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

const renderUpload = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <UploadPage />
      </MemoryRouter>
    </AuthProvider>,
  );

const pickNifti = async () => {
  const view = renderUpload();
  await screen.findByRole("button", { name: /^Model ePAI$/ });
  const input = view.container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
  await userEvent.upload(input, new File([new Uint8Array(CHUNK_SIZE)], "scan.nii.gz", { type: "application/gzip" }));
};

const statusLine = async (pattern: RegExp) => {
  let text = "";
  await waitFor(() => {
    text = Array.from(document.querySelectorAll(".status-msg"))
      .map((el) => el.textContent ?? "")
      .find((t) => pattern.test(t)) ?? "";
    expect(text).not.toBe("");
  }, { timeout: 4000 }); // chunk uploads retry a 502 or a dropped request twice first
  return text;
};

const TECHNICAL = /Expected JSON|HTTP \d|content-type|<html|Body:|text\/html|Failed to fetch|\.\)\./;

describe("upload failure messages", () => {
  it("says the server is busy when a proxy answers a chunk with an HTML 502, and logs the raw reply", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    chunkReply = () => html(502);
    await pickNifti();

    const text = await statusLine(/scan\.nii\.gz could not be uploaded/);
    expect(text).toBe(
      "scan.nii.gz could not be uploaded. The server is busy or restarting. Press Run to try again.",
    );
    expect(text).not.toMatch(TECHNICAL);
    const logged = consoleError.mock.calls.map((args) => args.map(String).join(" ")).join("\n");
    expect(logged).toMatch(/Expected JSON but got text\/html \(HTTP 502\)\. Body: <html>/);
  });

  it("says a 413 means the file is too large for the server, without offering a retry that would hit the same limit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    chunkReply = () => json({ error: "Request Entity Too Large" }, false, 413);
    await pickNifti();

    const text = await statusLine(/scan\.nii\.gz could not be uploaded/);
    expect(text).toBe(
      "scan.nii.gz could not be uploaded. The file is too large for the server to accept.",
    );
    expect(text).not.toMatch(TECHNICAL);
  });

  it("says the connection was lost when the request never got an answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    chunkReply = () => Promise.reject(new TypeError("Failed to fetch"));
    await pickNifti();

    const text = await statusLine(/scan\.nii\.gz could not be uploaded/);
    expect(text).toBe(
      "scan.nii.gz could not be uploaded. The connection to the server was lost. Press Run to try again.",
    );
  });

  it("explains a DICOM slice the server refuses as too large, without telling the user to send it again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sliceReply = () => json({ error: "Request Entity Too Large" }, false, 413);
    const slice = new File([new Uint8Array([0, 1, 2])], "slice-001.dcm");
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: () =>
        Promise.resolve({
          kind: "directory" as const,
          async *values() {
            yield { kind: "file" as const, getFile: async () => slice };
          },
        }),
    });
    renderUpload();
    await screen.findByRole("button", { name: /^Model ePAI$/ });
    await userEvent.click(screen.getByRole("button", { name: "Select DICOM" }));
    await screen.findByText("DICOM series (1 slice)");
    await userEvent.click(screen.getByRole("button", { name: "Run" }));

    const text = await statusLine(/DICOM upload failed/);
    expect(text).toBe(
      "DICOM upload failed. A slice in this folder is too large for the server to accept.",
    );
    expect(text).not.toMatch(TECHNICAL);
  });
});
