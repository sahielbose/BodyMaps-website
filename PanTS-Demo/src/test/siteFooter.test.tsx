import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SiteFooter from "../components/SiteFooter";
import {
  CONTACT_LINK_TEXT,
  CONTACT_URL,
  NONCLINICAL_WARNING,
} from "../helpers/copy";

describe("site footer", () => {
  it("shows the nonclinical notice and the inquiry link, nothing else", () => {
    render(<SiteFooter />);
    // Two sentence spans in one notice, so the text is read from the wrapper.
    expect(screen.getByText(/For nonclinical use only\./).parentElement?.textContent?.trim()).toBe(NONCLINICAL_WARNING);
    // The mission line moved to the landing subtitle; one-line footer.
    expect(screen.queryByText(/intelligence layer/)).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: CONTACT_LINK_TEXT });
    expect(link).toHaveAttribute("href", CONTACT_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/contact BodyMaps, Inc\. through/)).toBeInTheDocument();
  });

  it("no longer uses the generic commercial-use wording", () => {
    render(<SiteFooter />);
    expect(screen.queryByText(/For commercial use/)).not.toBeInTheDocument();
  });
});
