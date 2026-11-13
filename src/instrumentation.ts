export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { bootstrap } = await import("@/db/bootstrap");
      await bootstrap();
    } catch (e) {
      console.error("[bootstrap] failed:", e);
    }
  }
}
