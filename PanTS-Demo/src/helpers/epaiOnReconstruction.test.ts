import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startEpaiOnReconstruction } from "./epaiOnReconstruction";

// "Run ePAI on result" (the button after an OpenVAE reconstruction) is
// unreachable from the page today because OpenVAE is still "Coming soon", so
// the account rules for it are tested where they live: in the request helper.

const ok = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => "",
    headers: { get: () => "application/json" },
  }) as unknown as Response;

const parse = (res: Response) => res.json();

describe("startEpaiOnReconstruction", () => {
  // Who is signed in, mutable so a test can sign out or switch mid-request.
  let account: { ownerId: string | undefined; epoch: number };
  let reply: (body: unknown) => void;

  beforeEach(() => {
    account = { ownerId: "u1", epoch: 1 };
    global.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          reply = (body) => resolve(ok(body));
        }),
    ) as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  const start = () =>
    startEpaiOnReconstruction({
      sourceSessionId: "recon-1",
      newSessionId: "new-1",
      account: () => ({ ...account }),
      parseResponse: parse,
      now: () => 1234,
    });

  it("asks the server to run ePAI on the reconstruction under the new session id", async () => {
    const pending = start();
    reply({ session_id: "server-sid" });
    const started = await pending;

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("/api/run-epai-inference");
    const body = (init as RequestInit).body as FormData;
    expect(body.get("session_id")).toBe("new-1");
    expect(body.get("model_name")).toBe("ePAI");
    expect(body.get("source_reconstruction_session_id")).toBe("recon-1");
    expect(started.sessionId).toBe("server-sid");
    expect(started.superseded).toBe(false);
    expect(started.entry).toMatchObject({
      sessionId: "server-sid",
      label: "ePAI on reconstruction",
      model: "ePAI",
      status: "Processing",
      timestamp: 1234,
      ownerId: "u1",
    });
  });

  it("stamps the run with the account that started it, not the one signed in when the reply arrives", async () => {
    const pending = start();
    // The first person signs out and someone else signs in while it waits.
    account = { ownerId: "u2", epoch: 2 };
    reply({ session_id: "server-sid" });
    const started = await pending;

    expect(started.entry.ownerId).toBe("u1");
    // ...and the page is told not to adopt or poll it for the newcomer.
    expect(started.superseded).toBe(true);
  });

  it("a sign-out during the request leaves the run under its owner and superseded", async () => {
    const pending = start();
    account = { ownerId: undefined, epoch: 2 };
    reply({ session_id: "server-sid" });
    const started = await pending;

    expect(started.entry.ownerId).toBe("u1");
    expect(started.superseded).toBe(true);
  });

  it("falls back to the session id it sent when the reply names none", async () => {
    const pending = start();
    reply({ message: "started" });
    expect((await pending).sessionId).toBe("new-1");
  });

  it("surfaces the server's error and produces no run", async () => {
    global.fetch = vi.fn(async () =>
      ({
        ok: false,
        status: 403,
        json: async () => ({ error: "Not your reconstruction" }),
        text: async () => "",
        headers: { get: () => "application/json" },
      }) as unknown as Response,
    ) as unknown as typeof fetch;
    await expect(start()).rejects.toThrow("Not your reconstruction");
  });
});
