import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import TeamPage from "../routes/TeamPage";

// The site header reads the auth context, whose sign-in check would otherwise
// go to the network and could settle after the test environment is gone.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("team page", () => {
  it("links the two verified profiles and leaves the other cards unlinked", () => {
    render(
      <AuthProvider>
        <MemoryRouter>
          <TeamPage />
        </MemoryRouter>
      </AuthProvider>,
    );
    const zhou = screen.getByRole("link", { name: "Zongwei Zhou, PhD on LinkedIn" });
    expect(zhou).toHaveAttribute("href", "https://www.linkedin.com/in/zongwei-zhou");
    expect(zhou).toHaveAttribute("target", "_blank");
    expect(zhou).toHaveAttribute("rel", "noopener noreferrer");
    const li = screen.getByRole("link", { name: "Wenxuan Li on LinkedIn" });
    expect(li).toHaveAttribute("href", "https://www.linkedin.com/in/wenxuan-li-chelsea");
    // Exactly two profile links; the other four members have none yet.
    expect(screen.getAllByRole("link", { name: /on LinkedIn$/ })).toHaveLength(2);
    expect(screen.getByText("Alan L. Yuille, PhD")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Yuille/ })).not.toBeInTheDocument();
  });
});
