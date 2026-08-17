// Throwaway: dump the last N message texts from a topic matched by TITLE (not last-message
// preview). Uses openTopicByTitle deliberately - see client.js's documented trap.
// Usage: node peek.js "<title substring>" [n]
const { connect, openGroup, openTopicByTitle, getMessageTexts } = require("./client.js");

(async () => {
  const title = process.argv[2];
  const n = Number(process.argv[3] ?? 20);
  const { context, page } = await connect();
  await openGroup(page);
  await openTopicByTitle(page, title);
  const texts = await getMessageTexts(page, n);
  texts.forEach((t, i) => console.log(`--- [${i}] ---\n${t}`));
  await context.close();
})();
