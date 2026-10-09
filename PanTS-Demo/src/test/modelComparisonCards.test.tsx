import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";

// "pro" so the plan-aware default effect settles on ePAI; the comparison
// section is still shown until the user actively picks.
const USER = { id: "u1", email: "test.user@example.com", name: null, plan: "pro" };

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

describe("model comparison cards", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/api/auth/me")) return json({ user: USER });
      if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
      return json({ items: [], total: 0, ids: [] });
    }) as unknown as typeof fetch;
    localStorage.clear();
  });

  afterEach(() => vi.restoreAllMocks());

  const renderPage = async () => {
    render(
      <AuthProvider>
        <MemoryRouter>
          <UploadPage />
        </MemoryRouter>
      </AuthProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByText(/to run inference/)).not.toBeInTheDocument(),
    );
  };

  it("shows an info card for every real model (not None) before a choice is made", async () => {
    await renderPage();
    await screen.findByText("Choose a model");
    // The dropdown is closed, so each model's description text appears exactly
    // once - in its own comparison card. "None" (view-only) isn't a model to
    // compare, so it has no card here even though it's still a dropdown option.
    expect(screen.getByText(/Full abdominal organ segmentation/)).toBeInTheDocument();
    expect(screen.getByText(/anatomically consistent/)).toBeInTheDocument();
    expect(screen.getByText(/fast pancreatic lesion detection/)).toBeInTheDocument();
    expect(screen.queryByText(/View only: files never leave your browser/)).not.toBeInTheDocument();
  });

  it("stays put after a pick and moves the Selected badge to the clicked card", async () => {
    const user = userEvent.setup();
    await renderPage();
    await screen.findByText("Choose a model");

    // Default (pro) is ePAI - its card carries the Selected badge.
    const epaiCard = screen.getByText(/Full abdominal organ segmentation/).closest("[role=radio]")!;
    const atlasCard = screen.getByText(/anatomically consistent/).closest("[role=radio]")!;
    expect(within(epaiCard as HTMLElement).getByText("Selected")).toBeInTheDocument();

    await user.click(atlasCard);

    // The section is still there and every card is still shown; the badge just
    // moved to Atlas-Net.
    expect(screen.getByText("Choose a model")).toBeInTheDocument();
    expect(screen.getByText(/Full abdominal organ segmentation/)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(atlasCard as HTMLElement).getByText("Selected")).toBeInTheDocument(),
    );
    expect(within(epaiCard as HTMLElement).queryByText("Selected")).not.toBeInTheDocument();
  });
});
