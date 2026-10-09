import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import ContactPage from "../routes/ContactPage";
import { CONTACT_FORM_ENDPOINT } from "../helpers/copy";

// The page carries the site header, which reads the auth context; its sign-in
// check goes to /api and gets a 401 here. Calls to the form service are
// answered by `formReply`.
let formReply: () => Promise<Response>;
const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
  String(input) === CONTACT_FORM_ENDPOINT ? formReply() : new Response(null, { status: 401 }),
);
const formCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === CONTACT_FORM_ENDPOINT);

beforeEach(() => {
  formReply = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const renderPage = () =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/contact"]}>
        <ContactPage />
      </MemoryRouter>
    </AuthProvider>,
  );

async function fillValid(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Name/), "Ada Lovelace");
  await user.type(screen.getByLabelText(/^Work email/), "ada@example.org");
  await user.type(screen.getByLabelText(/^Organization/), "Example Hospital");
  await user.type(screen.getByLabelText(/^Role or title/), "Radiologist");
  await user.selectOptions(screen.getByLabelText(/^Inquiry type/), "research");
  await user.type(screen.getByLabelText(/^Message/), "We would like to evaluate the pancreas models.");
}

describe("contact page", () => {
  it("says what to send and warns against patient data", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Get in touch." })).toBeInTheDocument();
    expect(screen.getByText(/Do not send protected health information/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "hello@thebodymaps.com" })).toHaveAttribute(
      "href",
      "mailto:hello@thebodymaps.com",
    );
    expect(screen.getByRole("link", { name: "Privacy Notice" })).toHaveAttribute("href", "/privacy");
  });

  it("names every missing field, focuses the first one and sends nothing", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Send inquiry" }));

    const name = screen.getByLabelText(/^Name/);
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Enter your name.");
    expect(screen.getByLabelText(/^Inquiry type/)).toHaveAccessibleDescription("Choose the kind of inquiry.");
    expect(screen.getByLabelText(/^Message/)).toHaveAccessibleDescription("Tell us a little about your inquiry.");
    // Optional, so never marked.
    expect(screen.getByLabelText(/How did you hear about us/)).not.toHaveAttribute("aria-invalid");
    expect(formCalls()).toHaveLength(0);

    // Typing clears that field's error.
    await user.type(name, "A");
    expect(name).not.toHaveAttribute("aria-invalid");
  });

  it("checks the email shape and asks for more than a word or two", async () => {
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    await user.clear(screen.getByLabelText(/^Work email/));
    await user.type(screen.getByLabelText(/^Work email/), "ada@example");
    await user.clear(screen.getByLabelText(/^Message/));
    await user.type(screen.getByLabelText(/^Message/), "Hello");
    await user.click(screen.getByRole("button", { name: "Send inquiry" }));

    expect(screen.getByLabelText(/^Work email/)).toHaveFocus();
    expect(screen.getByLabelText(/^Work email/)).toHaveAccessibleDescription(/name@hospital\.org/);
    expect(screen.getByLabelText(/^Message/)).toHaveAccessibleDescription("Add a sentence or two so we can route it.");
    expect(formCalls()).toHaveLength(0);
  });

  it("posts the inquiry to BodyMaps, Inc.'s form and confirms where the reply goes", async () => {
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    await user.type(screen.getByLabelText(/How did you hear about us/), "MICCAI");
    await user.click(screen.getByRole("button", { name: "Send inquiry" }));

    const thanks = await screen.findByRole("heading", { name: "Thanks, your inquiry is on its way." });
    expect(thanks).toHaveFocus();
    expect(screen.getByText("ada@example.org")).toBeInTheDocument();

    expect(formCalls()).toHaveLength(1);
    const [, init] = formCalls()[0];
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Accept: "application/json", "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.org",
      org: "Example Hospital",
      role: "Radiologist",
      type: "research",
      message: "We would like to evaluate the pancreas models.",
      source: "MICCAI",
      _gotcha: "",
      _subject: "BodyMaps website inquiry: research",
    });

    // A second inquiry starts from an empty form.
    await user.click(screen.getByRole("button", { name: "Send another inquiry" }));
    expect(screen.getByLabelText(/^Name/)).toHaveValue("");
  });

  it("keeps the message and explains a refusal from the form service", async () => {
    formReply = async () =>
      new Response(JSON.stringify({ errors: [{ message: "Form not found." }] }), { status: 404 });
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Send inquiry" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your message was not sent. Form not found.");
    expect(alert).toHaveTextContent("hello@thebodymaps.com");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByLabelText(/^Message/)).toHaveValue("We would like to evaluate the pancreas models.");
    expect(screen.getByRole("button", { name: "Send inquiry" })).toBeEnabled();
  });

  it("explains a network failure", async () => {
    formReply = async () => {
      throw new TypeError("Failed to fetch");
    };
    const user = userEvent.setup();
    renderPage();
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "Send inquiry" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not reach the form service");
  });

  it("hides the spam trap from people and from the tab order", () => {
    renderPage();
    const trap = document.getElementById("contact-gotcha");
    expect(trap).toHaveAttribute("tabindex", "-1");
    expect(trap?.closest("[aria-hidden='true']")).not.toBeNull();
  });
});
