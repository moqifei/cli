/**
 * CardKit 流式回复：一轮一张卡，原地更新（移植自旧插件的
 * `streaming-card-controller.ts` 的可观察行为）。
 *
 * 生命周期与旧插件一致：
 *
 *   1. turn 一开始就建卡并发出去（「思考中」），不等第一个 token ——
 *      模型迟迟不吐字时用户也有反馈，且卡片是**回复**用户那条消息；
 *   2. 流式更新：工具面板 → 思考面板 → 回答正文（各自节流）；
 *   3. 终帧：工具/思考收起，正文补全，关掉 streaming 动画。
 *
 * 更新很贵（每次一个 CLI 往返），所以节流 + 严格串行：`sequence` 必须递增且
 * 帧不能重叠，否则 CardKit 会拒绝更新。
 */

import { buildCompleteCard, buildStreamingCard, buildThinkingCard, cleanReasoningText } from "./card.mjs";
import { createCard, updateCard, updateCardSettings } from "./cardkit.mjs";
import { sendCard } from "./outbound.mjs";
import { describeTool } from "./tool-display.mjs";

/** 回答帧：够快看起来是实时的，又不至于把 API 打爆。 */
const FLUSH_INTERVAL_MS = 400;
/** 思考帧：思考文本变化密集，放慢一点。 */
const REASONING_FLUSH_INTERVAL_MS = 900;
const MAX_CONSECUTIVE_FAILURES = 3;

export class StreamingReply {
  constructor({ account, to, log, reasoning, card, replyToMessageId, replyInThread = false }) {
    this.account = account;
    this.to = to;
    this.log = log;
    this.replyToMessageId = replyToMessageId;
    this.replyInThread = Boolean(replyInThread);

    const cardCfg = card ?? {};
    this.showToolUse = cardCfg.showToolUse !== false;
    this.loadingIcon = cardCfg.loadingIcon;
    this.footer = cardCfg.footer;

    this.reasoningEnabled = reasoning?.enabled !== false;
    this.reasoningExpanded = reasoning?.expanded === true;

    this.answer = "";
    this.reasoning = "";
    this.reasoningActive = false;
    this.reasoningStartedAt = 0;
    this.reasoningElapsedMs = 0;

    /** 工具步骤：`{title, iconToken, status, startedAt, endedAt}`。 */
    this.steps = [];
    this.toolsStartedAt = 0;
    this.toolsEndedAt = 0;

    this.startedAt = Date.now();
    this.cardId = null;
    this.sequence = 0;
    this.failed = false;
    this.closed = false;

    this.startPromise = null;
    this.lastFlushAt = 0;
    this.timer = null;
    this.inFlight = null;
    this.pending = false;
    this.consecutiveFailures = 0;
  }

  /** 卡片存在且更新链路仍然健康。 */
  get active() {
    return Boolean(this.cardId) && !this.failed;
  }

  get toolsElapsedMs() {
    if (!this.toolsStartedAt) return 0;
    return (this.toolsEndedAt || Date.now()) - this.toolsStartedAt;
  }

  /**
   * 建卡 + 发消息。幂等：并发调用共享同一个 promise。
   *
   * 这一步必须在 dispatch 一开始就调用，而不是等第一段文字。
   */
  async ensureStarted() {
    if (this.cardId) return this.cardId;
    if (this.failed || this.closed) return null;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      try {
        const card = buildThinkingCard({ loadingIcon: this.loadingIcon });
        const cardId = await createCard(this.account, card, { log: this.log });
        await sendCard({
          cliPath: this.account.cliPath,
          configDir: this.account.configDir,
          cwd: this.account.scratchDir,
          identity: this.account.identity,
          to: this.to,
          content: { type: "card", data: { card_id: cardId } },
          replyToMessageId: this.replyToMessageId,
          replyInThread: this.replyInThread,
          timeoutMs: this.account.sendTimeoutMs,
          env: this.account.env,
          log: this.log,
        });
        this.cardId = cardId;
        this.log.info(
          `streaming card created for ${this.to}${this.replyToMessageId ? ` (reply to ${this.replyToMessageId})` : ""} card_id=${cardId}`,
        );
        // streaming_mode 必须在第一次内容更新之前打开，否则飞书会把每帧渲染成
        // 「卡片已更新」而不是打字机效果。
        await updateCardSettings(this.account, cardId, { streaming_mode: true }, ++this.sequence, {
          log: this.log,
        }).catch((error) => {
          this.log.warn(`card streaming settings failed: ${error?.message ?? error}`);
        });
        return cardId;
      } catch (error) {
        this.failed = true;
        this.log.warn(`streaming card unavailable, falling back to text: ${error?.message ?? error}`);
        return null;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  onReasoning(text) {
    if (!this.reasoningEnabled) return;
    const cleaned = cleanReasoningText(text);
    if (!cleaned) return;
    if (!this.reasoningStartedAt) this.reasoningStartedAt = Date.now();
    this.reasoning = cleaned;
    this.reasoningActive = true;
    this.schedule({ reasoning: true });
  }

  onReasoningEnd() {
    if (!this.reasoningEnabled) return;
    this.reasoningActive = false;
    if (this.reasoningStartedAt && !this.reasoningElapsedMs) {
      this.reasoningElapsedMs = Date.now() - this.reasoningStartedAt;
    }
    this.schedule({ reasoning: true, force: true });
  }

  /** 工具开始：追加一步并展开工具面板（旧卡片行为）。 */
  onToolStart(name) {
    const label = String(name ?? "").trim();
    if (!label) return;
    // Orange 只把 `tool_start` 透给插件（`tool_finish` 走的是另一条通道），所以
    // 用「下一个工具开始」作为「上一个工具结束」的判据；终帧再把剩下的收尾。
    this.settleSteps();
    const described = describeTool(label);
    if (!this.toolsStartedAt) this.toolsStartedAt = Date.now();
    this.steps.push({
      title: described.title,
      iconToken: described.iconToken,
      status: "running",
      startedAt: Date.now(),
    });
    this.schedule({ force: true });
  }

  /** 把还在 running 的步骤标记为成功，并记录工具阶段结束时间。 */
  settleSteps() {
    let touched = false;
    for (const step of this.steps) {
      if (step.status !== "running") continue;
      step.status = "success";
      step.endedAt = Date.now();
      touched = true;
    }
    if (touched && this.toolsStartedAt) this.toolsEndedAt = Date.now();
    return touched;
  }

  /** 工具结束：把最后一步标记成功并记耗时。 */
  onToolEnd(name) {
    void name;
    this.settleSteps();
    this.schedule();
  }

  /** Host 的 `onPartialReply` 给的是累计文本。 */
  onAnswer(text) {
    const next = String(text ?? "");
    // 空白是 shim 的预热信号（约 150ms 时发一次），卡片已经由 ensureStarted 建好，
    // 这里绝不能把它当成回答内容。
    if (!next.trim()) return;
    // 开始出正文 = 工具阶段结束（卡片里工具面板也就该收起标题里的耗时了）。
    this.settleSteps();
    this.answer = next.startsWith(this.answer) || !this.answer ? next : `${this.answer}\n\n${next}`;
    this.schedule();
  }

  schedule({ reasoning = false, force = false } = {}) {
    if (this.failed || this.closed) return;
    const interval = reasoning && !force ? REASONING_FLUSH_INTERVAL_MS : FLUSH_INTERVAL_MS;
    const elapsed = Date.now() - this.lastFlushAt;
    const wait = force ? 0 : Math.max(0, interval - elapsed);

    if (wait === 0) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, wait);
    this.timer.unref?.();
  }

  async flush() {
    if (this.failed || this.closed) return;
    if (this.inFlight) {
      // 合并：后续帧只保留一帧，无论期间来了多少次更新。
      this.pending = true;
      return this.inFlight;
    }

    this.inFlight = (async () => {
      try {
        const cardId = await this.ensureStarted();
        if (!cardId || this.failed || this.closed) return;
        await updateCard(
          this.account,
          cardId,
          buildStreamingCard({
            steps: this.steps,
            stepsElapsedMs: this.toolsElapsedMs,
            answerText: this.answer,
            reasoningText: this.reasoningEnabled ? this.reasoning : "",
            reasoningActive: this.reasoningActive,
            reasoningExpanded: this.reasoningExpanded,
            reasoningElapsedMs: this.reasoningElapsedMs || undefined,
            showToolUse: this.showToolUse,
            loadingIcon: this.loadingIcon,
            streaming: true,
          }),
          ++this.sequence,
          { log: this.log },
        );
        this.lastFlushAt = Date.now();
        this.consecutiveFailures = 0;
      } catch (error) {
        this.consecutiveFailures += 1;
        this.log.warn(`card update failed (${this.consecutiveFailures}): ${error?.message ?? error}`);
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.failed = true;
          this.log.warn("giving up on streaming card updates; final answer will be sent as text");
        }
      } finally {
        this.inFlight = null;
        if (this.pending) {
          this.pending = false;
          this.schedule();
        }
      }
    })();

    return this.inFlight;
  }

  /**
   * 终帧 + 关掉 streaming 动画。
   * 返回 false 表示卡片不可用，调用方要退回纯文本。
   */
  async finish(finalText, { isError = false } = {}) {
    if (this.closed) return this.active;
    if (typeof finalText === "string" && finalText.trim()) {
      this.answer = finalText;
    }
    this.reasoningActive = false;
    if (this.reasoningStartedAt && !this.reasoningElapsedMs) {
      this.reasoningElapsedMs = Date.now() - this.reasoningStartedAt;
    }
    this.settleSteps();
    if (this.toolsStartedAt && !this.toolsEndedAt) this.toolsEndedAt = Date.now();

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // 卡片从来没建起来、也没有任何内容：保持安静，别在会话里留一张空卡。
    if (!this.cardId && !this.answer.trim() && !this.reasoning.trim() && !this.steps.length) {
      this.closed = true;
      return true;
    }

    if (this.failed) {
      this.closed = true;
      return false;
    }

    const cardId = await this.ensureStarted();
    if (!cardId || this.failed) {
      this.closed = true;
      return false;
    }

    if (this.inFlight) await this.inFlight.catch(() => {});

    try {
      await updateCard(
        this.account,
        cardId,
        buildCompleteCard({
          text: this.answer,
          steps: this.steps,
          stepsElapsedMs: this.toolsElapsedMs,
          reasoningText: this.reasoningEnabled ? this.reasoning : "",
          reasoningElapsedMs: this.reasoningElapsedMs || undefined,
          reasoningExpanded: this.reasoningExpanded,
          reasoningEnabled: this.reasoningEnabled,
          showToolUse: this.showToolUse,
          footer: this.footer,
          elapsedMs: Date.now() - this.startedAt,
          isError,
        }),
        ++this.sequence,
        { log: this.log },
      );
      await updateCardSettings(this.account, cardId, { streaming_mode: false }, ++this.sequence, {
        log: this.log,
      }).catch((error) => {
        this.log.warn(`card streaming shutdown failed: ${error?.message ?? error}`);
      });
      this.closed = true;
      return true;
    } catch (error) {
      this.log.warn(`final card update failed: ${error?.message ?? error}`);
      this.failed = true;
      this.closed = true;
      return false;
    }
  }

  /** dispatch 结束时没有 final delivery 的兜底。 */
  async close() {
    if (this.closed) return;
    await this.finish(this.answer);
  }
}
