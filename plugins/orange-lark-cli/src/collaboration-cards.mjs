import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { updateCard } from "./cardkit.mjs";
import { buildCollaborationApprovalCard } from "./card.mjs";

const writes = new Map();
const TERMINAL_STATES = new Set(["approved", "denied", "expired", "interrupted", "cancelled"]);

function storePath(account) {
  return join(account.configDir, "orange-lark-cli", "collaboration-cards.json");
}

async function readStore(account) {
  try {
    const value = JSON.parse(await readFile(storePath(account), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function serializeWrite(account, operation) {
  const path = storePath(account);
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  writes.set(path, next);
  return next.finally(() => {
    if (writes.get(path) === next) writes.delete(path);
  });
}

async function writeStore(account, store) {
  const path = storePath(account);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(store), { mode: 0o600 });
  await rename(temporaryPath, path);
}

/** Update an existing approval card. Repeated terminal controls are idempotent. */
export async function updateCollaborationApproval(account, approvalId, state, { log } = {}) {
  if (!approvalId || !TERMINAL_STATES.has(state)) {
    throw new Error(`invalid collaboration approval update (${approvalId || "missing id"}, ${state || "missing state"})`);
  }
  return serializeWrite(account, async () => {
    const store = await readStore(account);
    const key = `approval:${approvalId}`;
    const approval = store[key];
    if (!approval?.cardId) return false;
    if (approval.state === state && !approval.pendingState) return true;
    const recoveryInterrupt = approval.state === "approved" && state === "interrupted";
    if ((approval.state !== "pending" && !recoveryInterrupt) || (approval.pendingState && approval.pendingState !== state)) return false;

    // Persist intent before the network call. If the process dies after CardKit
    // accepts the update, Orange can safely retry and advance the sequence.
    const sequence = Number(approval.sequence || 1) + 1;
    store[key] = { ...approval, pendingState: state, sequence, updatedAt: Date.now() };
    await writeStore(account, store);
    try {
      await updateCard(
        account,
        approval.cardId,
        buildCollaborationApprovalCard(approval.approval ?? approval, state),
        sequence,
        { log },
      );
      store[key] = { ...store[key], state, updatedAt: Date.now() };
      delete store[key].pendingState;
      await writeStore(account, store);
      return true;
    } catch (error) {
      log?.warn?.(`collaboration approval card update failed (${approvalId}): ${error?.message ?? error}`);
      throw error;
    }
  });
}
