// One-off: hard-reload the Telegram Web K page then dump the sidebar - checks whether a topic
// still visible in the cached UI (e.g. one Telegram already deleted server-side) survives a
// fresh load, or was only a stale client-side cache artifact.
const { connect, openGroup } = require("./client.js");

(async () => {
  const { context, page } = await connect();
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(5000);
  await openGroup(page);
  await page.waitForTimeout(1500);
  const rows = page.locator(".chatlist-chat");
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    console.log(`--- row ${i} ---`);
    console.log((await rows.nth(i).innerText()).replace(/\n/g, " | "));
  }
  await context.close();
})();
