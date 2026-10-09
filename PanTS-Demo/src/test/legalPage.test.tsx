import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import LegalPage from "../routes/LegalPage";
import { CONTACT_PATH } from "../helpers/copy";

const renderLegal = (kind: "terms" | "privacy") =>
  // The legal pages carry the site header, which reads the auth context.
  render(
    <AuthProvider>
      <MemoryRouter>
        <LegalPage kind={kind} />
      </MemoryRouter>
    </AuthProvider>,
  );

// The site header reads the auth context, whose sign-in check would otherwise
// go to the network and could settle after the test environment is gone.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("legal pages", () => {
  it("terms: provisional status line, every section, nonclinical framing, contact route", () => {
    renderLegal("terms");
    expect(screen.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByText(/Provisional terms, under review\./)).toBeInTheDocument();
    for (const heading of [
      "Nonclinical use only",
      "Accounts",
      "What you upload",
      "Rights in uploads and annotations",
      "Plans and donations",
      "Acceptable use",
      "Availability and liability",
      "Where the service is operated",
      "Changes to these Terms",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
    }
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/placeholder|not yet in force|research use only/i);
    expect(text).toMatch(/masks you create are yours to use, including commercially/);
    expect(text).toMatch(/does not operate this site/);
    // The contact form is this site's own page now, so it opens in place.
    const links = screen.getAllByRole("link", { name: "contact form" });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link).toHaveAttribute("href", CONTACT_PATH);
      expect(link).not.toHaveAttribute("target");
    }
  });

  it("privacy: provisional status line, every section, truthful analytics wording", () => {
    renderLegal("privacy");
    expect(screen.getByRole("heading", { level: 1, name: "Privacy Notice" })).toBeInTheDocument();
    expect(screen.getByText(/Provisional privacy notice, under review\./)).toBeInTheDocument();
    for (const heading of [
      "What we collect",
      "Protected health information",
      "How we use it",
      "Site analytics, IP addresses and location",
      "Retention and deletion",
      "Sharing",
      "Your rights",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
    }
    const text = document.body.textContent ?? "";
    // The two sentences that were untrue today must be gone, replaced by the
    // guarantee + linkability disclosure and an honest retention statement.
    expect(text).not.toMatch(/deleted automatically|never used to identify you personally|placeholder/i);
    expect(text).toMatch(/will not use IP addresses, analytics events, browser identifiers, or derived location/);
    expect(text).toMatch(/so they are not anonymous/);
    expect(text).toMatch(/not yet deleted on a fixed schedule/);
  });
});
