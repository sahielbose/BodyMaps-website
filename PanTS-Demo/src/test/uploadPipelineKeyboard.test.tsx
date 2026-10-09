import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Profiler } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";

// The Upload page's pickers from the keyboard: the three pipeline dropdowns
// are ARIA menu buttons and the model comparison cards are a radio group
// with a single tab stop. Also pins that the page sits still while idle.

let plan = "pro";

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

beforeEach(() => {
  plan = "pro";
  localStorage.clear();
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/api/auth/me")) {
      return json({ user: { id: "u1", email: "one@example.com", name: null, plan } });
    }
    if (u.includes("/api/auth/oauth/providers")) return json({ google: true });
    return json({ items: [], total: 0, ids: [] });
  }) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const renderUpload = (onCommit?: () => void) =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <Profiler id="upload" onRender={() => onCommit?.()}>
          <UploadPage />
        </Profiler>
      </MemoryRouter>
    </AuthProvider>,
  );

const settled = (model: string) =>
  screen.findByRole("button", { name: new RegExp(`^Model ${model}`) });

describe("pipeline dropdowns", () => {
  it("expose their state and open, move and pick from the keyboard", async () => {
    const user = userEvent.setup();
    renderUpload();
    const trigger = await settled("ePAI");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Model" });
    // Opens on the current choice.
    const epai = within(menu).getByRole("menuitemradio", { name: "ePAI" });
    expect(epai).toHaveAttribute("aria-checked", "true");
    expect(epai).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitemradio", { name: "Atlas-Net" })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(within(menu).getByRole("menuitemradio", { name: "None" })).toHaveFocus();
    // Wraps from the first row to the last.
    await user.keyboard("{ArrowUp}");
    expect(within(menu).getByRole("menuitem", { name: "LesionSegmenter" })).toHaveFocus();
    await user.keyboard("{Home}{ArrowDown}{ArrowDown}");
    expect(within(menu).getByRole("menuitemradio", { name: "Atlas-Net" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu", { name: "Model" })).not.toBeInTheDocument();
    const updated = screen.getByRole("button", { name: /^Model Atlas-Net$/ });
    expect(updated).toHaveAttribute("aria-expanded", "false");
    expect(updated).toHaveFocus();
  });

  it("reaches the lesion submenu with ArrowRight and picks with Space", async () => {
    const user = userEvent.setup();
    renderUpload();
    const trigger = await settled("ePAI");
    trigger.focus();
    await user.keyboard("{ArrowUp}");
    const menu = screen.getByRole("menu", { name: "Model" });
    const lesion = within(menu).getByRole("menuitem", { name: "LesionSegmenter" });
    expect(lesion).toHaveFocus();
    expect(lesion).toHaveAttribute("aria-haspopup", "menu");
    expect(lesion).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{ArrowRight}");
    expect(lesion).toHaveAttribute("aria-expanded", "true");
    const sub = within(menu).getByRole("menu", { name: "LesionSegmenter" });
    expect(within(sub).getByRole("menuitemradio", { name: "Pancreatic lesion" })).toHaveFocus();
    // ArrowLeft goes back to the parent row without picking anything.
    await user.keyboard("{ArrowLeft}");
    expect(lesion).toHaveFocus();
    expect(lesion).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{ArrowRight}{ArrowDown}{ArrowDown}");
    expect(within(sub).getByRole("menuitemradio", { name: "Kidney lesion" })).toHaveFocus();
    await user.keyboard(" ");
    const updated = screen.getByRole("button", { name: /^Model LesionSegmenter \(kidney lesion\)$/ });
    expect(updated).toHaveFocus();
    expect(screen.queryByRole("menu", { name: "Model" })).not.toBeInTheDocument();
  });

  it("skips disabled rows and closes on Escape with focus back on the trigger", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled("ePAI");
    const trigger = screen.getByRole("button", { name: /^Preprocessing/ });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu", { name: /Preprocessing/ });
    const none = within(menu).getByRole("menuitemradio", { name: "None (skip)" });
    const openVae = within(menu).getByRole("menuitemradio", { name: "OpenVAE" });
    expect(openVae).toHaveAttribute("aria-disabled", "true");
    expect(none).toHaveFocus();

    // The only enabled row: the arrows never land on the disabled one.
    await user.keyboard("{ArrowDown}");
    expect(none).toHaveFocus();
    await user.keyboard("{End}");
    expect(none).toHaveFocus();
    // Clicking it does nothing either.
    await user.click(openVae);
    expect(openVae).toHaveAttribute("aria-checked", "false");

    none.focus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: /Preprocessing/ })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });
});

describe("pipeline menus at tablet widths", () => {
  // No layout in jsdom, so this asks which UploadPage.css rule wins for an
  // element at a given viewport width (later rules win ties; enough here).
  const css = readFileSync(resolve(process.cwd(), "src/routes/UploadPage.css"), "utf8");
  const mediaOn = (media: string, width: number) => {
    const min = /min-width:\s*(\d+)px/.exec(media);
    const max = /max-width:\s*(\d+)px/.exec(media);
    if (!min && !max) return false;
    return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
  };
  const valueAt = (el: Element, prop: string, width: number) => {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    let value: string | undefined;
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        const media = (rule as CSSMediaRule).media;
        if (media) {
          if (mediaOn(media.mediaText, width)) walk((rule as CSSMediaRule).cssRules);
          continue;
        }
        const styleRule = rule as CSSStyleRule;
        const v = styleRule.style?.getPropertyValue(prop);
        if (v && styleRule.selectorText.split(",").some((sel) => el.matches(sel.trim()))) value = v;
      }
    };
    walk(style.sheet!.cssRules);
    style.remove();
    return value;
  };

  it("opens the last step's menu leftwards while the steps share a squeezed row", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled("ePAI");
    const trigger = screen.getByRole("button", { name: /^Postprocessing/ });
    expect(trigger.closest(".pipeline-step")).toHaveClass("pipeline-step--last");
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: /Postprocessing/ }).closest(".model-dropdown-menu")!;

    for (const width of [641, 700, 760]) {
      expect(valueAt(menu, "left", width)).toBe("auto");
      expect(valueAt(menu, "right", width)).toMatch(/^0(px)?$/);
    }
    // Desktop keeps the menu hanging from the step's left edge.
    expect(valueAt(menu, "left", 1024)).toMatch(/^0(px)?$/);
  });

  it("shows the lesion choices inline up to 800px instead of a flyout off the edge", async () => {
    const user = userEvent.setup();
    renderUpload();
    await user.click(await settled("ePAI"));
    const sub = screen.getByRole("menu", { name: "LesionSegmenter" });

    for (const width of [375, 700, 780, 800]) {
      expect(valueAt(sub, "position", width)).toBe("static");
      expect(valueAt(sub, "visibility", width)).toBe("visible");
    }
    expect(valueAt(sub, "position", 1024)).toBe("absolute");
  });
});

describe("model comparison cards", () => {
  const cards = () => within(screen.getByRole("radiogroup", { name: "Choose a model" })).getAllByRole("radio");

  it("are one tab stop that the arrow keys move and select", async () => {
    const user = userEvent.setup();
    renderUpload();
    await settled("ePAI");
    const [epai, atlas, lesion] = cards();
    expect(cards().map((c) => c.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(epai).toHaveAttribute("aria-checked", "true");

    epai.focus();
    await user.keyboard("{ArrowRight}");
    expect(atlas).toHaveFocus();
    expect(atlas).toHaveAttribute("aria-checked", "true");
    expect(epai).toHaveAttribute("aria-checked", "false");
    expect(cards().map((c) => c.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    expect(screen.getByRole("button", { name: /^Model Atlas-Net$/ })).toBeInTheDocument();

    await user.keyboard("{ArrowDown}");
    expect(lesion).toHaveFocus();
    // Wraps around.
    await user.keyboard("{ArrowRight}");
    expect(epai).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(lesion).toHaveFocus();
    await user.keyboard("{Home}");
    expect(epai).toHaveFocus();
    expect(epai).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{End}");
    expect(lesion).toHaveFocus();
    expect(lesion).toHaveAttribute("aria-checked", "true");
  });

  it("move focus onto a locked card without selecting it", async () => {
    plan = "free";
    const user = userEvent.setup();
    renderUpload();
    await settled("LesionSegmenter");
    const [, atlas, lesion] = cards();
    expect(lesion).toHaveAttribute("tabindex", "0");

    lesion.focus();
    await user.keyboard("{ArrowLeft}");
    expect(atlas).toHaveFocus();
    expect(atlas).toHaveAttribute("aria-checked", "false");
    expect(lesion).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText(/needs Pro/)).not.toBeInTheDocument();
    // Enter on it explains the lock instead, in a dialog that takes focus
    // and hands it back to the card on Escape.
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Atlas-Net needs Pro" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(atlas).toHaveFocus();
  });
});

describe("while idle", () => {
  it("does not re-render once a second", async () => {
    let commits = 0;
    renderUpload(() => {
      commits += 1;
    });
    await settled("ePAI");
    // Let the auth, plan and usage requests land. This first second also
    // absorbs the one empty pass React may make the first time a state
    // update turns out to change nothing (it commits without rendering the
    // page); after that such updates are dropped before any work.
    await act(() => new Promise((r) => setTimeout(r, 1200)));
    const before = commits;
    await act(() => new Promise((r) => setTimeout(r, 2200)));
    expect(commits).toBe(before);
  });
});
