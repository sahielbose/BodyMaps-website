import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage, { __resetUploadTabState } from "../routes/UploadPage";

const USER = { id: "u1", email: "test.user@example.com", name: null, plan: "pro" };
const CHUNK_SIZE = 512 * 1024;

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

const makeFile = (name: string) =>
  new File([new Uint8Array(CHUNK_SIZE)], name, { type: "application/gzip" });

describe("completed inference actions", () => {
  beforeEach(() => {
    __resetUploadTabState();
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(url);
      if (endpoint.includes("/api/auth/me")) return json({ user: USER });
      if (endpoint.includes("/api/auth/oauth/providers")) return json({ google: true });
      if (endpoint.includes("/api/upload-inference-chunk")) return json({ ok: true });
      if (endpoint.includes("/api/finalize-upload")) {
        return json({ uploaded_filename: "scan.nii.gz" });
      }
      if (endpoint.includes("/api/run-epai-inference")) {
        const sessionId = String((init?.body as FormData).get("session_id"));
        return json({ message: "Segmentation started", session_id: sessionId });
      }
      if (endpoint.includes("/api/inference-status/")) {
        return json({ status: "completed" });
      }
      return json({ items: [], total: 0, ids: [] });
    }) as unknown as typeof fetch;
    localStorage.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  // The panel used to render as a stand-alone card below the drop zone (added
  // there, then it visibly overlapped the box while also making the box's own
  // size depend on whether a run had finished). It's back to living INSIDE the
  // drop zone now - but in the SAME slot that showed the file chip and then
  // the progress card, replacing them in place rather than a new box
  // appearing anywhere else on the page.
  it("replaces the file chip / progress card in place, doesn't add a panel elsewhere", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AuthProvider>
        <MemoryRouter>
          <UploadPage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument(),
    );

    const dropzone = container.querySelector(".dropzone")!;
    const dropzoneClassBefore = dropzone.className;

    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, new File([new Uint8Array([1, 2, 3])], "scan.nii.gz"));
    await screen.findByText(/ready/);
    await user.click(screen.getByRole("button", { name: "Run" }));

    const completedPanel = await screen.findByRole("status");
    expect(completedPanel).toHaveTextContent("Inference complete");
    // In the drop zone's own slot...
    expect(completedPanel.closest(".dropzone")).toBe(dropzone);
    // ...one panel only, and the drop zone's class list is unaffected (no
    // has-result-style modifier reappearing to resize the box by state).
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(dropzone.className).toBe(dropzoneClassBefore);
  });

  it("relabels the batch progress bar to Inference complete in the same slot, once all scans finish", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AuthProvider>
        <MemoryRouter>
          <UploadPage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument(),
    );

    const dropzone = container.querySelector(".dropzone")!;
    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, [makeFile("a.nii.gz"), makeFile("b.nii.gz")]);
    await waitFor(() => expect(screen.getAllByText(/ready/).length).toBe(2));
    await user.click(screen.getByRole("button", { name: "Run" }));

    const doneBar = await screen.findByText("Inference complete", {}, { timeout: 5000 });
    expect(doneBar.closest(".dropzone")).toBe(dropzone);
    // No Cancel button left once there's nothing to cancel.
    expect(screen.queryByRole("button", { name: /^Cancel all scans in 2 scans started / })).not.toBeInTheDocument();
    // The spinning icon next to the status line stops once nothing is running -
    // it was previously left spinning forever alongside "Inference complete".
    expect(dropzone.querySelector(".upload-spinner")).toBeNull();
    expect(dropzone.querySelector(".proc-done-icon")).not.toBeNull();

    // Viewing it releases the slot - the box goes back to normal instead of
    // holding onto a finished batch forever.
    await user.click(screen.getByRole("button", { name: /^View details for 2 scans started / }));
    await waitFor(() =>
      expect(screen.queryByText("Inference complete")).not.toBeInTheDocument(),
    );
  });

  // The finished bar unmounts as the popup mounts, so the popup's opener is
  // gone when it closes: focus goes to the page heading, and what Download did
  // is told inside the popup.
  it("tells a failed Download inside the batch popup and keeps focus on the page when it closes", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AuthProvider>
        <MemoryRouter>
          <UploadPage />
        </MemoryRouter>
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument(),
    );
    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, [makeFile("a.nii.gz"), makeFile("b.nii.gz")]);
    await waitFor(() => expect(screen.getAllByText(/ready/).length).toBe(2));
    await user.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Inference complete", {}, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: /^View details for 2 scans started / }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Download all" }));
    // The mocked result has no file body, so both downloads fail.
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent(/Downloaded 0 of 2 scans/));
    expect(container.querySelector(".status-msg")?.textContent ?? "").not.toMatch(/Downloaded|Preparing/);

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "Upload a CT scan" })).toHaveFocus();
  });

  // A Download keeps reporting after the popup is closed; its late lines must
  // not show up the next time a popup opens.
  it("does not carry a note from a closed popup into the next one", async () => {
    let releaseResult: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseResult = resolve; });
    const base = global.fetch;
    global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("/api/get_result/")) {
        await held;
        throw new Error("late failure");
      }
      return base(url, init);
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    const { container } = render(
      <AuthProvider>
        <MemoryRouter>
          <UploadPage />
        </MemoryRouter>
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument(),
    );
    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, [makeFile("a.nii.gz"), makeFile("b.nii.gz")]);
    await waitFor(() => expect(screen.getAllByText(/ready/).length).toBe(2));
    await user.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Inference complete", {}, { timeout: 5000 });

    await user.click(screen.getByRole("button", { name: /^View details for 2 scans started / }));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Download all" }));
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent(/Preparing download/));
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    // The download finishes (and fails) with the popup closed.
    await act(async () => { releaseResult(); await held; });
    await user.click(await screen.findByRole("button", { name: /^View details for 2 scans started / }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("status")).toBeEmptyDOMElement();
  });
});
