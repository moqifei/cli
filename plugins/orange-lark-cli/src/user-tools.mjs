/**
 * feishu_search_user / feishu_get_user — 通讯录查询。
 *
 * Ported from openclaw-lark/src/tools/oapi/common/{search-user,get-user}.ts.
 * Those went through the SDK (`/open-apis/search/v1/user`,
 * `contact.v3.user.get`); here the same calls are made with lark-cli:
 *
 *   contact +search-user --query <kw>  --as user   # 姓名/邮箱/手机号 -> open_id + 邮箱 + 部门
 *   contact +search-user --user-ids <.> --as user  # 已知 open_id 回填字段（字段最全）
 *   contact +get-user                    --as user   # 自己
 *
 * Identity choice matters: this tenant's app token cannot read arbitrary users
 * (`41050 no user authority`), so "someone else" always goes through the user
 * token, which is also what grants the department / email fields the OA skill
 * needs to turn a name into a mailbox address.
 *
 * Dependencies are injected to reuse the lark_cli authorization gate instead of
 * re-implementing it (a contact scope the user never granted must produce the
 * same device-flow card, not a raw `missing_scope` string).
 */

const SEARCH_NAME = "feishu_search_user";
const GET_NAME = "feishu_get_user";

function toolText(text, details) {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** `contact +search-user` row -> the shape the old tool returned. */
function normalizeUser(raw) {
  if (!raw || typeof raw !== "object") return null;
  const openId = raw.open_id ?? raw.openId ?? raw.user_id ?? "";
  if (!openId) return null;
  const name = raw.localized_name ?? raw.name ?? raw.en_name ?? openId;
  const enterpriseEmail = raw.enterprise_email ?? "";
  const personalEmail = raw.email ?? "";
  return {
    open_id: openId,
    name,
    localized_name: name,
    en_name: raw.en_name ?? "",
    // 邮箱兜底：OA 的技能拿这个字段当「经办人邮箱」用，企业邮箱优先。
    email: enterpriseEmail || personalEmail,
    enterprise_email: enterpriseEmail,
    personal_email: personalEmail,
    department: raw.department ?? "",
    avatar_url: raw.avatar_url ?? raw.avatar?.avatar_240 ?? "",
    is_activated: raw.is_activated ?? true,
    is_cross_tenant: raw.is_cross_tenant ?? false,
    has_chatted: raw.has_chatted ?? Boolean(raw.p2p_chat_id),
    p2p_chat_id: raw.p2p_chat_id ?? "",
    chat_recency_hint: raw.chat_recency_hint ?? "",
    description: raw.signature ?? "",
  };
}

function unwrap(result) {
  const envelope = result?.data ?? {};
  // Some commands wrap under `data`, others (auth status) do not.
  return envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
}

function failureText(error) {
  const code = Number(error?.error?.code ?? 0);
  if (code === 41050) {
    return (
      "查询不到该用户：41050 无用户权限。\n\n" +
      "说明：用用户身份调通讯录时，可查范围由当前用户的**组织架构可见范围**决定，而不是应用权限。\n" +
      "建议：请管理员调整可见范围，或改用应用身份（bot）调用。"
    );
  }
  return `查询失败：${error?.error?.message ?? error?.message ?? error}`;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createUserTools({
  getAccounts,
  logger,
  toolCtx,
  ensureUserAuthorized,
  runCli,
  isScopeFailure,
  invalidateAuthStatus,
  resolveOwnerAccount = null,
}) {
  function resolveAccount() {
    const accounts = getAccounts();
    // 通讯录一律走 `--as user`：必须落到本人目录，共享目录里是别人的 token。
    // 拿不到「人」时授权门会 fail-close，这里才允许回到声明的账号。
    const scoped = resolveOwnerAccount?.();
    if (scoped) return scoped;
    const inbound = toolCtx?.openclawInboundContext ?? {};
    const wantedId = inbound.AccountId ?? toolCtx?.deliveryContext?.accountId;
    return accounts.find((entry) => entry.accountId === wantedId) ?? accounts[0];
  }

  /**
   * Run one lark-cli call behind the same authorization gate as `lark_cli`:
   * cached status first, then a device-flow card when the token is unusable,
   * and a second gate carrying `missing_scopes` when a scope was never granted.
   */
  async function invoke(account, argv, log) {
    const gate = await ensureUserAuthorized({ account, argv, toolCtx, log, force: false, trigger: "token" });
    if (gate) return { awaiting: gate };

    const run = () =>
      runCli({
        cliPath: account.cliPath,
        configDir: account.configDir,
        cwd: account.scratchDir,
        args: [...argv, "--format", "json"],
        timeoutMs: 20_000,
        env: account.env,
        log,
      });

    try {
      return { data: await run() };
    } catch (error) {
      if (!isScopeFailure(error)) throw error;
      invalidateAuthStatus(account);
      const retryGate = await ensureUserAuthorized({
        account,
        argv,
        toolCtx,
        log,
        force: true,
        trigger: "scope",
        missingScopes: error?.error?.missing_scopes ?? null,
      });
      // already_authorized 不是「已发卡」：把真实错误抛回去，别让模型等一张
      // 永远不会出现的授权卡片。
      if (retryGate && !retryGate.already_authorized) return { awaiting: retryGate };
      throw error;
    }
  }

  const searchTool = {
    name: SEARCH_NAME,
    label: "Feishu: Search User",
    description:
      "按关键词（姓名 / 邮箱 / 手机号）搜索员工，返回姓名、open_id、邮箱、部门等信息。结果按亲密度排序。" +
      "已知 open_id 想补全字段时，传 user_ids。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词，匹配姓名 / 邮箱 / 手机号（必填）" },
        user_ids: {
          type: "array",
          items: { type: "string" },
          description: "已知 open_id 列表（最多 100），用于回填字段；与 query 同传时在集合内匹配",
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "返回条数，默认 20，最大 30（lark-cli 不支持翻页 token）",
        },
      },
      required: ["query"],
    },

    async execute(_toolCallId, params) {
      const query = typeof params?.query === "string" ? params.query.trim() : "";
      const userIds = Array.isArray(params?.user_ids)
        ? params.user_ids.filter((v) => typeof v === "string" && v.trim())
        : [];
      if (!query && userIds.length === 0) {
        return toolText("ERROR: query 不能为空（已知 open_id 时可只传 user_ids）", { ok: false });
      }

      const account = resolveAccount();
      if (!account) return toolText("ERROR: 没有配置飞书账号", { ok: false });
      const log = logger.child(account.accountId);

      const size = Math.min(Math.max(Number(params?.page_size) || 20, 1), 30);
      const argv = ["contact", "+search-user", "--page-size", String(size), "--as", "user"];
      if (userIds.length) argv.push("--user-ids", userIds.join(","));
      if (query) argv.push("--query", query);

      try {
        const result = await invoke(account, argv, log);
        if (result.awaiting) return toolText(JSON.stringify(result.awaiting), result.awaiting);

        const payload = unwrap(result.data);
        const users = (Array.isArray(payload?.users) ? payload.users : [])
          .map(normalizeUser)
          .filter(Boolean);
        log.info(`search_user: query="${query}" found=${users.length} has_more=${payload?.has_more ?? false}`);
        return toolText(
          JSON.stringify({ users, count: users.length, has_more: payload?.has_more ?? false }),
          { ok: true, count: users.length },
        );
      } catch (error) {
        log.warn(`search_user failed: ${error?.message ?? error}`);
        return toolText(failureText(error), { ok: false });
      }
    },
  };

  const getUserTool = {
    name: GET_NAME,
    label: "Feishu: Get User Info",
    description:
      "获取用户信息（姓名、邮箱、部门、头像等）。不传 user_id 时返回当前用户自己；传 user_id 时返回指定用户。" +
      "拿到姓名后要邮箱，用 feishu_search_user 更完整。",
    parameters: {
      type: "object",
      properties: {
        user_id: { type: "string", description: "用户 ID；为空则返回当前用户自己" },
        user_id_type: {
          type: "string",
          enum: ["open_id", "union_id", "user_id"],
          description: "user_id 的类型，默认 open_id",
        },
      },
    },

    async execute(_toolCallId, params) {
      const userId = typeof params?.user_id === "string" ? params.user_id.trim() : "";
      const userIdType = ["open_id", "union_id", "user_id"].includes(params?.user_id_type)
        ? params.user_id_type
        : "open_id";

      const account = resolveAccount();
      if (!account) return toolText("ERROR: 没有配置飞书账号", { ok: false });
      const log = logger.child(account.accountId);

      // 传了 ID：先用 search-user 回填（字段最全，含企业邮箱），失败再退回 get-user。
      if (userId) {
        if (userIdType === "open_id") {
          try {
            const rich = await invoke(
              account,
              ["contact", "+search-user", "--user-ids", userId, "--as", "user"],
              log,
            );
            if (rich.awaiting) return toolText(JSON.stringify(rich.awaiting), rich.awaiting);
            const users = (Array.isArray(unwrap(rich.data)?.users) ? unwrap(rich.data).users : [])
              .map(normalizeUser)
              .filter(Boolean);
            const hit = users.find((user) => user.open_id === userId) ?? users[0];
            if (hit) {
              log.info(`get_user: ${userId} resolved via search-user`);
              return toolText(JSON.stringify({ user: hit }), { ok: true, source: "search-user" });
            }
          } catch (error) {
            log.warn(`get_user: search-user fallback for ${userId}: ${error?.message ?? error}`);
          }
        }

        try {
          const result = await invoke(
            account,
            ["contact", "+get-user", "--user-id", userId, "--user-id-type", userIdType, "--as", "user"],
            log,
          );
          if (result.awaiting) return toolText(JSON.stringify(result.awaiting), result.awaiting);
          const payload = unwrap(result.data);
          const user = normalizeUser(payload?.user ?? payload) ?? { open_id: userId };
          log.info(`get_user: ${userId} resolved via get-user`);
          return toolText(JSON.stringify({ user }), { ok: true, source: "get-user" });
        } catch (error) {
          log.warn(`get_user failed: ${error?.message ?? error}`);
          return toolText(failureText(error), { ok: false });
        }
      }

      try {
        const result = await invoke(account, ["contact", "+get-user", "--as", "user"], log);
        if (result.awaiting) return toolText(JSON.stringify(result.awaiting), result.awaiting);
        const payload = unwrap(result.data);
        const user = normalizeUser(payload?.user ?? payload);
        if (!user) return toolText("ERROR: 当前用户信息为空", { ok: false });
        log.info(`get_user: current user resolved open_id=${user.open_id}`);
        return toolText(JSON.stringify({ user }), { ok: true, source: "self" });
      } catch (error) {
        log.warn(`get_user (self) failed: ${error?.message ?? error}`);
        return toolText(failureText(error), { ok: false });
      }
    },
  };

  return { search: searchTool, getUser: getUserTool };
}
