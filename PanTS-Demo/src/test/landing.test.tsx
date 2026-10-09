import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import LandingPage from "../routes/LandingPage";
import { LANDING_OVERVIEW, LANDING_SUBTITLE } from "../helpers/copy";

// The landing page fetches the live CT count; stub it so the test never
// touches a backend (same shape as routes.smoke.test.tsx).
beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items: [], total: 0, ids: [] }),
    text: async () => "",
    headers: { get: () => "application/json" },
  })) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("landing hero copy", () => {
  it("is one screen: wordmark, subtitle, two ways in, the stats row, and nothing after it", () => {
    render(
      <AuthProvider>
        <MemoryRouter>
          <LandingPage />
        </MemoryRouter>
      </AuthProvider>,
    );
    const subtitle = screen.getByText(LANDING_SUBTITLE);
    expect(subtitle.previousElementSibling?.tagName).toBe("H1");
    // The overview paragraph was dropped to keep the hero clean.
    expect(screen.queryByText(LANDING_OVERVIEW)).not.toBeInTheDocument();
    const stats = screen.getByText("CT volumes").closest("dl");
    expect(stats).not.toBeNull();
    expect(stats?.nextElementSibling).toBeNull();
    // The nonclinical sentence lives in the footer, never in the hero.
    expect(stats?.parentElement?.textContent).not.toMatch(/nonclinical|research use only/i);
  });
});
