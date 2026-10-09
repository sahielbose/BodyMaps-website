import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Header from "../components/Header";
import { AuthProvider } from "../contexts/authContext";

const renderHeader = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <Header />
      </MemoryRouter>
    </AuthProvider>,
  );

// The site header reads the auth context, whose sign-in check would otherwise
// go to the network and could settle after the test environment is gone.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("header navigation", () => {
  it("keeps the four routed tabs and omits the external CONTACT entry", () => {
    renderHeader();
    for (const label of ["Overview", "Dataset", "Upload", "Team"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("link", { name: /CONTACT/i })).not.toBeInTheDocument();
  });
});
