import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Use the Supabase DIRECT connection (port 5432) or the session pooler for migrations. DATABASE_URL is read from .env or the shell.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db", ssl: process.env.DATABASE_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined },
});
