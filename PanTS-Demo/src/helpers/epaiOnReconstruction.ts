import { API_BASE } from "./constants";
import type { RecentUpload } from "./recentUploads";

// "Run ePAI on result" starts a second run on a finished reconstruction. The
// request takes a while to answer, and the person who sent it can sign out or
// switch account before it does. Two things follow from that:
//
//   - The run belongs to whoever sent the request, so the account is read
//     BEFORE the request goes out, never from whoever is signed in when the
//     reply arrives (that would hand the run, and its result, to the wrong
//     account's list).
//   - If the account changed meanwhile, the page must not adopt the new run
//     as the current scan or poll it: the new account can't read it, and its
//     "Inference complete" card is for its own scan. The run still goes into
//     the list under its real owner so that account finds it on its return.
export type EpaiOnReconstructionStart = {
  sessionId: string;
  // The list entry to store, already stamped with the account that asked.
  entry: RecentUpload;
  // The signed-in account (epoch) changed while the request was in flight.
  superseded: boolean;
};

export async function startEpaiOnReconstruction(opts: {
  // Finished reconstruction to run on, and the fresh session id to run under.
  sourceSessionId: string;
  newSessionId: string;
  // Who is signed in right now and which sign-in that is (it moves on every
  // sign-in, sign-out or account switch). Read once before the request goes
  // out and once when the reply comes back.
  account: () => { ownerId: string | undefined; epoch: number };
  parseResponse: (res: Response) => Promise<any>;
  now?: () => number;
}): Promise<EpaiOnReconstructionStart> {
  const { sourceSessionId, newSessionId, account, parseResponse } = opts;
  const { ownerId, epoch: epochAtStart } = account();

  const formData = new FormData();
  formData.append("session_id", newSessionId);
  formData.append("model_name", "ePAI");
  formData.append("source_reconstruction_session_id", sourceSessionId);

  const res = await fetch(`${API_BASE}/api/run-epai-inference`, {
    method: "POST",
    body: formData,
  });
  const data = await parseResponse(res);
  if (!res.ok) {
    throw new Error(data.error || "Failed to start ePAI inference on reconstruction");
  }

  const sessionId: string = data.session_id || newSessionId;
  return {
    sessionId,
    superseded: account().epoch !== epochAtStart,
    entry: {
      sessionId,
      label: "ePAI on reconstruction",
      model: "ePAI",
      status: "Processing",
      timestamp: (opts.now ?? Date.now)(),
      ownerId,
    },
  };
}
