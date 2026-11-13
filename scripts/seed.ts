import "dotenv/config";
async function main() {
  const { bootstrap } = await import("../src/db/bootstrap");
  const { seedDemo } = await import("../src/db/seed");
  const t = Date.now();
  await bootstrap();
  const r = await seedDemo();
  console.log(r.skipped ? "Demo organisation already exists - nothing to do" : `Demo data seeded in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
