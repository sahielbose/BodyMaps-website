import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import UploadPage from "../routes/UploadPage";

const USER = { id: "u1", email: "test.user@example.com", name: null, plan: "pro" };

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => "",
  headers: { get: () => "application/json" },
});

describe("DICOM directory picker", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/auth/me")) return json({ user: USER });
      if (String(url).includes("/api/auth/oauth/providers")) return json({ google: true });
      return json({ items: [], total: 0, ids: [] });
    }) as unknown as typeof fetch;
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it("invokes showDirectoryPicker with Window as its receiver", async () => {
    const dicom = new File([new Uint8Array([0, 1, 2])], "slice-001.dcm");
    const directory = {
      kind: "directory" as const,
      async *values() {
        yield { kind: "file" as const, getFile: async () => dicom };
      },
    };
    const picker = vi.fn(function (this: Window) {
      if (this !== window) throw new TypeError("Illegal invocation");
      return Promise.resolve(directory);
    });
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: picker,
    });

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

    await userEvent.click(screen.getByRole("button", { name: "Select DICOM" }));

    await waitFor(() => expect(picker).toHaveBeenCalledOnce());
    expect(picker.mock.instances[0]).toBe(window);
    expect(await screen.findByText("DICOM series (1 slice)")).toBeInTheDocument();
  });
});
