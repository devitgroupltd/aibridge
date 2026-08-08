import { buildAboutKeyboard, renderAbout } from "./about.ts";
import { buildCommandKeyboard, listRepoCommands, listRepoSkills, renderCommandsListText, renderSkillsListText } from "./commands.ts";
import { renderHelp } from "./fleet-commands.ts";
import { buildDiffReview } from "./diff-review.ts";
import { buildDirKeyboard, buildHitsKeyboard, BrowseRegistry, renderDirText, renderHitsText } from "./browse-nav.ts";
import { listDirectory, searchWorktree } from "./worktree-fs.ts";
import type { SessionRoute } from "./routing.ts";
import type { ConfirmSessionCommand } from "./session-supervisor.ts";
import type { SendMessageSource } from "./telegram.ts";

/** `/about`, `/help`, `/commands`, `/skills`, `/browse`, `/find`, `/diff` - each reached by both an
 * exact-syntax command and its NL-matched (nl-router.ts) equivalent, extracted here so there's one
 * place to keep the two paths in sync. Thin wrappers around already-tested renderers
 * (about.ts/commands.ts/browse-nav.ts/diff-review.ts/worktree-fs.ts) - low risk, mainly a
 * readability win, no test file proposed (mirrors fleet-reporting-commands.ts, item 8). */
export interface CardSendersOptions {
  controlBot: SendMessageSource;
  confirmSessionCommand: ConfirmSessionCommand;
  browseRegistry: BrowseRegistry;
  supergroupChatId: string;
  log: (level: "INFO" | "WARN" | "ERROR", message: string) => void;
}

export interface CardSenders {
  sendAboutCard(threadId: number | undefined): void;
  sendHelpCard(threadId: number | undefined, route: SessionRoute | undefined): void;
  sendCommandsListCard(threadId: number | undefined, route: SessionRoute | undefined, term: string): void;
  sendSkillsListCard(threadId: number | undefined, route: SessionRoute | undefined, term: string): void;
  sendBrowseCard(threadId: number | undefined, route: SessionRoute | undefined, requestedPath: string): void;
  sendFindCard(threadId: number | undefined, route: SessionRoute | undefined, query: string): void;
  sendDiffCard(threadId: number | undefined, route: SessionRoute | undefined): void;
}

export function createCardSenders(opts: CardSendersOptions): CardSenders {
  const { controlBot, confirmSessionCommand, browseRegistry, supergroupChatId, log } = opts;

  /** `/about`'s exact-syntax and NL-matched (`kind: "about"`, nl-router.ts) paths both call this -
   * extracted so there's one place to keep in sync. */
  function sendAboutCard(threadId: number | undefined): void {
    controlBot
      .sendMessage(supergroupChatId, threadId, renderAbout(), { inline_keyboard: buildAboutKeyboard() })
      .catch((err) => log("WARN", `sendMessage (/about) failed: ${(err as Error).message}`));
  }

  /** `/help`'s exact-syntax and NL-matched (`kind: "help"`, nl-router.ts) paths both call this. */
  function sendHelpCard(threadId: number | undefined, route: SessionRoute | undefined): void {
    const repoCommands = route ? listRepoCommands(route.worktreePath) : [];
    const repoSkills = route ? listRepoSkills(route.worktreePath) : [];
    controlBot
      .sendMessage(supergroupChatId, threadId, renderHelp(), { inline_keyboard: buildCommandKeyboard(repoCommands, repoSkills) })
      .catch((err) => log("WARN", `sendMessage (command list) failed: ${(err as Error).message}`));
  }

  /** `/commands [<term>]`'s exact-syntax and NL-matched (`kind: "commands"`, nl-router.ts) paths
   * both call this - session-scoped only (no worktree to read commands from without a `route`). */
  function sendCommandsListCard(threadId: number | undefined, route: SessionRoute | undefined, term: string): void {
    const text = route
      ? renderCommandsListText(listRepoCommands(route.worktreePath), term)
      : "Repo commands are session-scoped - send /commands inside a session's own topic.";
    controlBot.sendMessage(supergroupChatId, threadId, text).catch((err) => log("WARN", `sendMessage (/commands) failed: ${(err as Error).message}`));
  }

  /** `/skills [<term>]`'s exact-syntax and NL-matched (`kind: "skills"`, nl-router.ts) paths both
   * call this - same session-scoping as `sendCommandsListCard`. */
  function sendSkillsListCard(threadId: number | undefined, route: SessionRoute | undefined, term: string): void {
    const text = route
      ? renderSkillsListText(listRepoSkills(route.worktreePath), term)
      : "Repo skills are session-scoped - send /skills inside a session's own topic.";
    controlBot.sendMessage(supergroupChatId, threadId, text).catch((err) => log("WARN", `sendMessage (/skills) failed: ${(err as Error).message}`));
  }

  /** `/browse [<path>]` - session-scoped only, same as `sendCommandsListCard`. An invalid/escaping
   * `path` argument (worktree-fs.ts's `resolveWorktreeRelPath` rejects it) is reported, not silently
   * clamped to the root. */
  function sendBrowseCard(threadId: number | undefined, route: SessionRoute | undefined, requestedPath: string): void {
    if (!route) {
      confirmSessionCommand(threadId, "File browsing is session-scoped - send /browse inside a session's own topic.");
      return;
    }
    const listing = listDirectory(route.worktreePath, requestedPath);
    if (!listing) {
      confirmSessionCommand(threadId, `Can't browse "${requestedPath || "/"}" - it doesn't exist, or is outside this session's worktree.`);
      return;
    }
    controlBot
      .sendMessage(supergroupChatId, threadId, renderDirText(listing), { inline_keyboard: buildDirKeyboard(browseRegistry, route.slug, listing) })
      .catch((err) => log("WARN", `sendMessage (/browse) failed: ${(err as Error).message}`));
  }

  /** `/find <query>` - session-scoped only. The hit set is a snapshot taken now, stored once in
   * `browseRegistry` (kind "hitset") and paged from that snapshot rather than re-searched per page -
   * see browse-nav.ts's own doc comment on `buildHitsKeyboard` for why. */
  function sendFindCard(threadId: number | undefined, route: SessionRoute | undefined, query: string): void {
    if (!route) {
      confirmSessionCommand(threadId, "File search is session-scoped - send /find inside a session's own topic.");
      return;
    }
    const result = searchWorktree(route.worktreePath, query);
    const hitsetId = browseRegistry.add(route.slug, { kind: "hitset", query, ...result });
    controlBot
      .sendMessage(supergroupChatId, threadId, renderHitsText(query, result, 0), {
        inline_keyboard: buildHitsKeyboard(browseRegistry, route.slug, hitsetId, result.hits, 0),
      })
      .catch((err) => log("WARN", `sendMessage (/find) failed: ${(err as Error).message}`));
  }

  /** `/diff` - session-scoped only. Pushes the session's pending (uncommitted) changes to a
   * throwaway GitHub branch and replies with a compare-view link (diff-review.ts), or a scrubbed
   * `.diff` document when there's no GitHub remote or the push itself fails - see that module's own
   * doc comment for the full design. */
  function sendDiffCard(threadId: number | undefined, route: SessionRoute | undefined): void {
    if (!route) {
      confirmSessionCommand(threadId, "Diff review is session-scoped - send /diff inside a session's own topic.");
      return;
    }
    const review = buildDiffReview(route.worktreePath, route.slug);
    const untrackedNote = review.untrackedFiles.length > 0 ? ` ${review.untrackedFiles.length} new file(s) not shown - /browse to view: ${review.untrackedFiles.join(", ")}` : "";
    if (review.kind === "empty") {
      confirmSessionCommand(threadId, review.untrackedFiles.length > 0 ? `No tracked changes.${untrackedNote}` : "No pending changes.");
      return;
    }
    if (review.kind === "link" && review.url) {
      controlBot
        .sendMessage(supergroupChatId, threadId, `${review.filesChanged} file(s) changed.${untrackedNote}`, {
          inline_keyboard: [[{ text: "Open diff on GitHub", url: review.url }]],
        })
        .catch((err) => log("WARN", `sendMessage (/diff) failed: ${(err as Error).message}`));
      return;
    }
    if (review.kind === "document" && review.diffText !== undefined && controlBot.sendDocumentFile) {
      controlBot
        .sendDocumentFile(supergroupChatId, threadId, `${route.slug}.diff`, new TextEncoder().encode(review.diffText), `${review.filesChanged} file(s) changed.${untrackedNote}`)
        .catch((err) => log("WARN", `sendDocumentFile (/diff) failed: ${(err as Error).message}`));
    }
  }

  return { sendAboutCard, sendHelpCard, sendCommandsListCard, sendSkillsListCard, sendBrowseCard, sendFindCard, sendDiffCard };
}
