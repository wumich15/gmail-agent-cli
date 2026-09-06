import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type GmailAgentDatabase } from "../../src/state/database.js";
import { AccountsRepository } from "../../src/state/repositories/accounts.js";
import { ActionsRepository, RunsRepository } from "../../src/state/repositories/runs.js";
import type { PlannedAction } from "../../src/core/models.js";

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): GmailAgentDatabase {
  dir = mkdtempSync(join(tmpdir(), "gmail-agent-test-"));
  const db = openDatabase(join(dir, "state.sqlite"));
  new AccountsRepository(db).upsert({
    accountHash: "acct1",
    emailDisplay: null,
    timezone: "UTC",
    historyMarker: null,
    setupComplete: true,
    automationEnabled: false,
    createdAt: "now",
    updatedAt: "now"
  });
  const runs = new RunsRepository(db);
  for (const runId of ["run_a", "run_b"]) {
    runs.create({
      runId,
      accountHash: "acct1",
      mode: "work",
      policyVersion: "policy-v2",
      classifierVersion: null,
      promptVersion: null,
      schemaVersion: null,
      startedAt: "now",
      finishedAt: null,
      status: "running",
      counters: {},
      errorSummary: null
    });
  }
  return db;
}

function action(overrides: Partial<PlannedAction> = {}): PlannedAction {
  return {
    actionKey: "same-key",
    runId: "run_a",
    accountHash: "acct1",
    type: "archive",
    targetGmailMessageId: "msg1",
    targetGmailThreadId: "thread1",
    targetCalendarEventId: null,
    reasonCode: "read_non_trash",
    beforeStateHash: null,
    payloadHash: "hash",
    status: "planned",
    attemptCount: 0,
    errorClass: null,
    createdAt: "now",
    updatedAt: "now",
    ...overrides
  };
}

describe("ActionsRepository.upsertPlanned", () => {
  it("lets a later run re-claim a non-terminal action", () => {
    const db = freshDb();
    const repo = new ActionsRepository(db);
    repo.upsertPlanned([action({ runId: "run_a", status: "planned" })]);
    repo.upsertPlanned([action({ runId: "run_b", status: "planned" })]);

    const row = db.prepare("SELECT run_id FROM actions WHERE action_key = ?").get("same-key") as {
      run_id: string;
    };
    expect(row.run_id).toBe("run_b");
    db.close();
  });

  it("never reassigns an action that already reached a terminal status", () => {
    const db = freshDb();
    const repo = new ActionsRepository(db);
    repo.upsertPlanned([action({ runId: "run_a", status: "planned" })]);
    repo.updateStatus("same-key", "applied", "now");

    // A later run derives the same logical action again (e.g. the same
    // read message would still be archived) and tries to re-plan it.
    repo.upsertPlanned([action({ runId: "run_b", status: "planned" })]);

    const row = db.prepare("SELECT run_id, status FROM actions WHERE action_key = ?").get("same-key") as {
      run_id: string;
      status: string;
    };
    expect(row.run_id).toBe("run_a");
    expect(row.status).toBe("applied");
    db.close();
  });
});

describe("ActionsRepository.updateStatus", () => {
  it("increments attempt_count only on the transition into 'applying', not on every status change", () => {
    // Regression: a lone successful attempt used to read attempt_count: 2
    // (once for the "applying" transition, again for the terminal
    // "applied" transition), silently doubling this audit field.
    const db = freshDb();
    const repo = new ActionsRepository(db);
    repo.upsertPlanned([action({ status: "planned" })]);
    repo.updateStatus("same-key", "applying", "t1");
    repo.updateStatus("same-key", "applied", "t2");

    const row = db.prepare("SELECT attempt_count FROM actions WHERE action_key = ?").get("same-key") as {
      attempt_count: number;
    };
    expect(row.attempt_count).toBe(1);
    db.close();
  });

  it("counts a real second attempt (applying again after a retryable failure) as attempt 2", () => {
    const db = freshDb();
    const repo = new ActionsRepository(db);
    repo.upsertPlanned([action({ status: "planned" })]);
    repo.updateStatus("same-key", "applying", "t1");
    repo.updateStatus("same-key", "failed_retryable", "t2");
    repo.updateStatus("same-key", "applying", "t3");
    repo.updateStatus("same-key", "applied", "t4");

    const row = db.prepare("SELECT attempt_count FROM actions WHERE action_key = ?").get("same-key") as {
      attempt_count: number;
    };
    expect(row.attempt_count).toBe(2);
    db.close();
  });
});
