/**
 * `/new`'s three startup gates (`session.ready`, `waitForChannelConnected`, `waitForPtyQuiet`) all
 * degrade to a WARN in `bridge.log` and proceed - deliberately, since none of them may ever fire and
 * a `/new` that wedges forever is worse than one that writes a bit early. What was missing until now
 * is the other half of that bargain: when they *do* degrade, the operator was told nothing at all.
 *
 * Found live 2026-08-16 on the first `/new` against a repo other than aibridge itself. SeoWrite's
 * own tracked `.mcp.json` declares seven project-scoped MCP servers, so Claude Code opened its
 * "New MCP server found in this project: trello" consent dialog and sat on it. `session.ready`'s 30s
 * timeout fired, then `waitForChannelConnected`'s 15s, and `startFirstTurn` wrote the operator's
 * first prompt into that open modal - whose highlighted option the trailing `\r` then selected:
 *
 *     20:08:08  WARN timed out waiting for the channel server to connect - proceeding anyway
 *     20:08:09  [pty] "Use this MCP server ✔"
 *
 * The prompt was consumed by the dialog and never ran. Every visible signal said the session was
 * fine: the topic showed "Created ..." and a "🤔 Thinking..." placeholder, `/ls` showed it `idle`,
 * `/usage` showed $0.00. This is the §9 silent-wrong class exactly - a plausible-looking result that
 * is simply not what happened - and nothing downstream catches it, because `pty-io.ts`'s
 * `confirmSubmitted` only asks "did the PTY produce output", and a dialog being answered and redrawn
 * is plenty of output.
 *
 * So the gates now report their outcome and this module turns that into one operator-facing line.
 * It does not change what gets written: the prompt still goes out, because the gates are heuristics
 * and discarding the operator's text on a heuristic is its own silent failure. It only stops the
 * failure being silent.
 */

export interface StartupGateResults {
  /** `session.ready` resolved on its 30s safety timeout rather than on the status bar appearing -
   * i.e. we never actually saw Claude Code finish starting. */
  startupTimedOut: boolean;
  /** The channel server completed its MCP handshake. `false` is the severe one: the aibridge channel
   * is how a session *replies*, so a session that never connected it cannot answer into its topic
   * even if the prompt did land. */
  channelConnected: boolean;
  /** The PTY went quiet before the write. Reported in the detail list but never on its own - see
   * `describeStartupGateFailures`. */
  ptyQuiet: boolean;
}

/**
 * The operator-facing notice, or `undefined` when there is nothing to say.
 *
 * **`ptyQuiet` alone never raises this**, on purpose. Its 8s ceiling (`DEFAULT_QUIET_TIMEOUT_MS`) is
 * routinely reached by an honest cold `npx -y @playwright/mcp@latest` on a brand-new worktree path,
 * and that case is already handled downstream by `confirmSubmitted`'s retry and, failing that,
 * `autoRecoverWedgedSession`. A warning on every `/new` would be noise, and noise is how a real
 * warning gets ignored. The two gates that *do* raise it mean something structurally different:
 * startup never visibly finished, or the session has no reply path at all.
 */
export function describeStartupGateFailures(slug: string, results: StartupGateResults): string | undefined {
  const { startupTimedOut, channelConnected, ptyQuiet } = results;
  if (!startupTimedOut && channelConnected) return undefined;

  const details: string[] = [];
  if (startupTimedOut) details.push("• Claude Code never finished starting up (30s) - anything still on screen, a consent dialog included, would have swallowed the message");
  if (!channelConnected) details.push("• the aibridge channel never connected (15s) - this session may not be able to reply here at all");
  if (!ptyQuiet) details.push("• the session was still producing output when the message went out (8s)");

  return [
    `⚠️ "${slug}" was written to before it finished starting, so its first message may not have run:`,
    ...details,
    "",
    "It was sent anyway rather than dropped. If this topic stays quiet, send it again, or /restart.",
  ].join("\n");
}
