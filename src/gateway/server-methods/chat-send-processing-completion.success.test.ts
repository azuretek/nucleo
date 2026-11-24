import { expect, it } from "vitest";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.js";
import { readSessionInputCompletion } from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const createFixture = useBrowserFollowupFixture();

it("records the completion row of a successful signed-in browser input before releasing its owner", async () => {
  const fixture = await createFixture({ preserveContent: true, persistDuringDispatch: true });
  const profile = ensureProfileForEmail("successful-completion@example.test");
  fixture.client.authenticatedUserProfile = {
    profileId: profile.id,
    displayName: "Input author",
    hasAvatar: false,
    updatedAt: 1,
  };
  try {
    const ack = await fixture.send();
    expect(ack.mock.calls[0]?.[0]).toBe(true);
    const recorder = await fixture.dispatchedRecorder;
    // Observe the live recorder: a released owner at completion time would skip the row.
    const order: string[] = [];
    const releasedAtCompletion: boolean[] = [];
    const complete = recorder.completeProcessing!.bind(recorder);
    const finish = recorder.finishPendingInput!.bind(recorder);
    recorder.completeProcessing = (outcome) => {
      order.push("complete");
      releasedAtCompletion.push(recorder.isPendingInputReleased?.() === true);
      return complete(outcome);
    };
    recorder.finishPendingInput = (disposition) => {
      order.push("finish:" + disposition);
      finish(disposition);
    };
    await fixture.finishDispatch();
    expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    expect(order[0]).toBe("complete");
    expect(order.filter((step) => step === "complete")).toHaveLength(1);
    expect(releasedAtCompletion).toEqual([false]);
    const completion = readSessionInputCompletion(
      openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(fixture.scope))),
      { ...fixture.scope, idempotencyKey: `${fixture.params.idempotencyKey}:user` },
    );
    expect(completion).toMatchObject({
      run_id: fixture.params.idempotencyKey,
      session_id: fixture.scope.sessionId,
      succeeded: 1,
      outcome: { reason: "completed" },
    });
    expect(listSessionPendingInputs(fixture.scope).items).toEqual([]);
  } finally {
    await fixture.cleanup();
  }
});
