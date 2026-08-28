import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";

// What a Free account runs into on the Upload page, and what it's told.
//
// The server is the enforcer (flask-server/services/plan_store.py) — these
// cover the client half: locked controls that explain themselves before you
// commit, and the 402 path for the limits only the server can know about.

const CHUNK_SIZE = 512 * 1024;
const USER = {
  id: "u1", email: "test.user@example.com", name: null, plan: "free",
};

const makeFile = (name: string) =>
  new File([new Uint8Array(CHUNK_SIZE)], name, { type: "application/gzip" });

const json = (body: unknown, ok = true, status = 200) => ({
  ok, status,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

/** Set by a test that wants /run-inference to refuse. */
let inferenceRefusal: Record<string, unknown> | null = null;

beforeEach(() => {
  inferenceRefusal = null;
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/api/auth/me")) return json({ user: USER });
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    if (u.includes("/api/me/usage")) {
      return json({
        plan: "free",
        limits: { daily_scans: 3 },
        scans: { used: 3, limit: 3, in_flight: 0, resets_at: null },
        ai_messages: { used: 0, limit: 10, resets_at: null },
      });
    }
    if (u.includes("/api/upload-inference-chunk")) return json({ ok: true });
    if (u.includes("/api/finalize-upload")) return json({ uploaded_filename: "ct.nii.gz" });
    if (u.includes("/api/run-epai-inference")) {
      if (inferenceRefusal) return json(inferenceRefusal, false, 402);
      return json({ message: "Segmentation started" });
    }
    if (u.includes("/api/inference-status/")) return json({ status: "queued" });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const renderUpload = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/upload"]}>
        <Routes>
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/account/plan" element={<div>Plan settings</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  );

/** Waits out the /auth/me probe so the page knows who is signed in. */
const settled = () =>
  waitFor(() =>
    expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument()
  );

// Free plan only includes LesionSegmenter, so that's the picker's default
// once the plan-aware effect settles (see UploadPage's modelTouchedRef
// effect) - "None" is only the pre-auth placeholder.
const openModelMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: /LesionSegmenter/ }));
};

describe("model access", () => {
  it("keeps locked models visible with an upgrade marker rather than hiding them", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled();
    await openModelMenu(user);

    // The free model is offered; the rest are shown but marked.
    expect(screen.getByText("LesionSegmenter")).toBeInTheDocument();
    expect(screen.getByText("ePAI")).toBeInTheDocument();
    expect(screen.getAllByText("Donate").length).toBeGreaterThan(0);
  });

  it("explains the lock instead of selecting the model", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled();
    await openModelMenu(user);
    await user.click(screen.getByText("ePAI"));

    expect(await screen.findByText("ePAI needs Pro")).toBeInTheDocument();
    // The picker did not change to the model that was refused - still on its
    // (also unlocked) default.
    expect(screen.getByRole("button", { name: /LesionSegmenter/ })).toBeInTheDocument();
  });

  it("lets the free model through untouched", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled();
    await openModelMenu(user);
    await user.click(screen.getByText("LesionSegmenter"));

    expect(screen.queryByText(/needs Pro/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /LesionSegmenter/ })).toBeInTheDocument();
  });

  it("sends you to the plan page from the dialog", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled();
    await openModelMenu(user);
    await user.click(screen.getByText("ePAI"));
    await user.click(await screen.findByRole("button", { name: "See donation options" }));

    expect(await screen.findByText("Plan settings")).toBeInTheDocument();
  });

  it("closes without going anywhere on Not now", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled();
    await openModelMenu(user);
    await user.click(screen.getByText("ePAI"));
    await user.click(await screen.findByRole("button", { name: "Not now" }));

    await waitFor(() =>
      expect(screen.queryByText("ePAI needs Pro")).not.toBeInTheDocument()
    );
    expect(screen.queryByText("Plan settings")).not.toBeInTheDocument();
  });
});

describe("postprocessing", () => {
  // ShapeKit isn't wired into the run yet (its value was never sent anywhere),
  // so it is disabled as coming soon on every plan - not sold behind a lock.
  it("shows ShapeKit as coming soon and refuses to select it", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled();

    // Preprocessing (step 1) and postprocessing (step 3) share the placeholder;
    // the second is the one ShapeKit lives under.
    const skipButtons = screen.getAllByRole("button", { name: /None \(skip\)/ });
    await user.click(skipButtons[skipButtons.length - 1]);

    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    await user.click(screen.getByText("ShapeKit"));

    // No upgrade dialog for a control that does nothing, and no selection:
    // both step triggers still read "None (skip)".
    expect(screen.queryByText("ShapeKit needs Pro")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /None \(skip\)/ })
    ).toHaveLength(2);
  });
});

describe("running several scans at once", () => {
  it("says so before uploading anything, rather than one refusal per file", async () => {
    const user = userEvent.setup();
    const { container } = renderUpload();
    await settled();

    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, [makeFile("a.nii.gz"), makeFile("b.nii.gz")]);

    await openModelMenu(user);
    await user.click(screen.getByText("LesionSegmenter"));
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("One scan at a time on Free")).toBeInTheDocument();
    // Nothing was sent.
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c) => String(c[0]).includes("upload-inference-chunk"))).toBe(false);
  });

  it("counts a scan already in flight against the limit", async () => {
    const running: RecentUpload = {
      sessionId: "s-running", label: "earlier.nii.gz", model: "LesionSegmenter",
      status: "Processing", timestamp: Date.now(),
    };
    localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify([running]));

    const user = userEvent.setup();
    const { container } = renderUpload();
    await settled();

    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, [makeFile("a.nii.gz")]);
    await openModelMenu(user);
    await user.click(screen.getByText("LesionSegmenter"));
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("One scan at a time on Free")).toBeInTheDocument();
  });
});

describe("the server's own refusal", () => {
  it("turns a 402 into the same dialog, with the server's numbers", async () => {
    inferenceRefusal = {
      error: "You've used your 3 scans for today",
      code: "plan_limit",
      reason: "daily_scans",
      plan: "free",
      limit: 3,
      used: 3,
      resets_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    };

    const user = userEvent.setup();
    const { container } = renderUpload();
    await settled();

    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, [makeFile("a.nii.gz")]);
    await openModelMenu(user);
    await user.click(screen.getByText("LesionSegmenter"));
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(
      await screen.findByText("You've used your scans for today", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    // The reset time comes from the server, not a guess.
    expect(screen.getByText(/next one is available in about 6 hours/i)).toBeInTheDocument();
  });

  it("marks the refused scan cancelled, not failed — nothing broke", async () => {
    inferenceRefusal = {
      error: "You've used your 3 scans for today",
      code: "plan_limit", reason: "daily_scans", plan: "free", limit: 3, used: 3,
    };

    const user = userEvent.setup();
    const { container } = renderUpload();
    await settled();

    const input = container.querySelector<HTMLInputElement>('input[accept=".nii,.gz"]')!;
    await user.upload(input, [makeFile("a.nii.gz")]);
    await openModelMenu(user);
    await user.click(screen.getByText("LesionSegmenter"));
    await user.click(screen.getByRole("button", { name: "Run" }));

    await screen.findByText("You've used your scans for today", {}, { timeout: 5000 });
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) || "[]");
      expect(stored[0]?.status).toBe("Cancelled");
    });
  });
});

describe("signed out", () => {
  it("asks for a sign-in in as few words as possible", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/auth/me")) return json({ user: null });
      if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
      return json({ items: [], total: 0, ids: [] });
    }) as unknown as typeof fetch;

    renderUpload();
    expect(await screen.findByText(/to run inference\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/get notified when it's done/i);
  });

  it("locks nothing before it knows who you are", async () => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/auth/me")) return json({ user: null });
      if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
      return json({ items: [], total: 0, ids: [] });
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderUpload();
    await screen.findByText(/to run inference\./);
    // Signed out: the plan-aware default effect never fires (nothing to gate
    // against yet), so the picker is still on its pre-auth "None" - not
    // openModelMenu, which assumes a signed-in default.
    await user.click(screen.getByRole("button", { name: /None \(view scan\)/ }));

    expect(screen.queryByText("Donate")).not.toBeInTheDocument();
  });
});
