import assert from "node:assert/strict";
import test from "node:test";

import { mapMessageEvent } from "../src/mapper.mjs";

function mapMentions(mentions, botOpenId = "ou_bot") {
  return mapMessageEvent({
    type: "im.message.receive_v1",
    message_id: "om_message",
    chat_id: "oc_group",
    chat_type: "group",
    message_type: "text",
    sender_id: "ou_sender",
    sender_type: "user",
    content: "hello",
    mentions,
  }, { accountId: "work", botOpenId }).context;
}

test("message mapper distinguishes an explicit bot mention from @all", () => {
  const botMention = mapMentions([{ id: "ou_bot", key: "@_user_1" }]);
  assert.equal(botMention.WasMentioned, true);
  assert.equal(botMention.BotWasMentioned, true);

  const allMention = mapMentions([{ id: "all", key: "@_all" }]);
  assert.equal(allMention.WasMentioned, true);
  assert.equal(allMention.BotWasMentioned, false);
});

test("unknown bot identity preserves the legacy mention gate without claiming an explicit bot mention", () => {
  const context = mapMentions([{ id: "ou_someone_else", key: "@_user_2" }], null);
  assert.equal(context.WasMentioned, true);
  assert.equal(context.BotWasMentioned, false);
});
