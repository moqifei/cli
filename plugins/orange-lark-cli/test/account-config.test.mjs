import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { accountsFromChannelConfig, normalizeAccounts } from "../src/index.mjs";

function withOrangeHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orange-home-"));
  const previous = process.env.ORANGE_HOME;
  process.env.ORANGE_HOME = home;
  try {
    fn(home);
  } finally {
    if (previous === undefined) delete process.env.ORANGE_HOME;
    else process.env.ORANGE_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("channel accounts seed lark-cli config with a file-backed secret", () => {
  withOrangeHome((home) => {
    const api = {
      config: {
        channels: {
          feishu: {
            domain: "feishu",
            accounts: {
              work: { enabled: true, appId: "cli_test", appSecret: "s3cret" },
            },
          },
        },
      },
    };

    const fallback = accountsFromChannelConfig(api);
    assert.equal(fallback.work.app_id, "cli_test");
    assert.equal(fallback.work.app_secret, "s3cret");

    const [account] = normalizeAccounts({}, fallback, api.config.channels.feishu);
    const dir = path.join(home, "data", "lark-cli", "work");
    assert.equal(account.configDir, dir);

    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.equal(config.apps[0].appId, "cli_test");
    assert.deepEqual(config.apps[0].appSecret, {
      source: "file",
      id: path.join(dir, ".appsecret"),
    });
    assert.deepEqual(config.apps[0].users, [], "user tokens must be obtained by that user");
    assert.equal(fs.readFileSync(path.join(dir, ".appsecret"), "utf8"), "s3cret");
    assert.equal(fs.statSync(path.join(dir, ".appsecret")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, "config.json")).mode & 0o777, 0o600);
  });
});

test("an existing lark-cli config is never overwritten", () => {
  withOrangeHome((home) => {
    const dir = path.join(home, "data", "lark-cli", "work");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const existing = {
      apps: [
        {
          appId: "cli_manual",
          appSecret: { source: "file", id: "/tmp/already-there" },
          brand: "feishu",
          users: [],
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(existing, null, 2));

    normalizeAccounts(
      {},
      { work: { config_dir: dir, identity: "bot", app_id: "cli_test", app_secret: "s3cret" } },
      {},
    );

    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")),
      existing,
    );
    assert.equal(fs.existsSync(path.join(dir, ".appsecret")), false);
  });
});

test("unexpanded env references are left for config init", () => {
  withOrangeHome((home) => {
    const dir = path.join(home, "data", "lark-cli", "work");
    normalizeAccounts(
      {},
      {
        work: {
          config_dir: dir,
          identity: "bot",
          app_id: "cli_test",
          app_secret: "${FEISHU_APP_SECRET}",
        },
      },
      {},
    );
    assert.equal(fs.existsSync(path.join(dir, "config.json")), false);
  });
});
