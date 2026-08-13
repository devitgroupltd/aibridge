// Dumps the topic list's DOM shape - specifically, which element inside a `.chatlist-chat` row
// holds the topic *title* versus the last-message *preview*.
//
// Why this exists: client.js's `openTopic` matches `.chatlist-chat` by `hasText` over the whole
// row, which includes the preview line. Right after a `/new`, the control topic's own preview reads
// `Created "<slug>" (...)`, so a search for the new session's slug matches the *control* topic too -
// and `.first()` picks it, because the control topic is the most recently active row. Two live runs
// of always-rule-check.js silently drove the control topic instead of the session's own topic
// before this was spotted (every command "worked", nothing happened).
//
// Usage: node inspect-chatlist.js
const { connect, openGroup } = require("./client.js");

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await page.waitForTimeout(1500);

  const rows = await page.locator(".chatlist-chat").evaluateAll((els) =>
    els.map((el) => {
      // Which list is this row in? Topic rows and ordinary chat rows share `.chatlist-chat`, so the
      // containing list is what tells them apart.
      const list = el.closest("ul, .chatlist");
      return {
        container: list ? `${list.tagName}.${list.className}`.slice(0, 80) : null,
        title: el.querySelector(".row-title")?.textContent?.trim().slice(0, 50) ?? null,
        wholeRowText: el.textContent?.trim().replace(/\s+/g, " ").slice(0, 70) ?? "",
      };
    }),
  );

  console.log(JSON.stringify(rows, null, 1));
  await context.close();
})();
