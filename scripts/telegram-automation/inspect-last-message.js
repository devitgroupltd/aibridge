const { connect, openGroup, openTopic } = require("./client.js");

(async () => {
  const { context, page } = await connect();
  await openGroup(page);
  await openTopic(page, "General");
  await page.waitForTimeout(1000);
  const bubbles = page.locator(".bubble");
  const count = await bubbles.count();
  const n = Number(process.argv[2] ?? 1);
  for (let i = Math.max(0, count - n); i < count; i++) {
    console.log(`--- bubble ${i} ---`);
    console.log(await bubbles.nth(i).innerHTML());
  }
  await context.close();
})();
