// Dumps the visible text of every topic row in the forum's sidebar.
const { connect, openGroup } = require("./client.js");

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await page.waitForTimeout(1000);
  const rows = page.locator(".chatlist-chat");
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    console.log(`--- row ${i} ---`);
    console.log((await rows.nth(i).innerText()).replace(/\n/g, " | "));
  }
  await context.close();
})();
