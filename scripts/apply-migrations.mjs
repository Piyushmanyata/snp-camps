import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const DATABASE_URL =
  process.env.SNP_TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres";

async function run() {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();

  console.log("Recreating public schema...");
  await c.query("drop schema if exists public cascade; create schema public; grant all on schema public to postgres; grant all on schema public to public;");
  await c.query("create schema if not exists auth; create schema if not exists extensions; grant all on schema auth to postgres; grant all on schema auth to public;");
  await c.query(`
    create table if not exists auth.users (
      id uuid primary key,
      instance_id uuid,
      aud varchar(255),
      role varchar(255),
      email varchar(255),
      encrypted_password varchar(255),
      email_confirmed_at timestamptz,
      raw_app_meta_data jsonb,
      raw_user_meta_data jsonb,
      created_at timestamptz,
      updated_at timestamptz
    );
  `);
  await c.query('create extension if not exists "pgcrypto" schema extensions;');
  await c.query('create extension if not exists "uuid-ossp" schema extensions;');
  await c.query('create extension if not exists "pg_trgm" schema extensions;');
  await c.query('set search_path to public, extensions, pg_catalog;');
  await c.query('create or replace function public.gen_random_bytes(int) returns bytea language sql as $$ select extensions.gen_random_bytes($1) $$;');
  await c.query('create or replace function public.uuid_generate_v4() returns uuid language sql as $$ select extensions.uuid_generate_v4() $$;');

  console.log(`Applying ${files.length} migrations...`);
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    process.stdout.write(`Applying ${f}... `);
    try {
      await c.query('set search_path to public, extensions, pg_catalog;');
      await c.query(sql);
      console.log("OK");
    } catch (err) {
      console.log("ERROR:", err.message);
      await c.end();
      process.exit(1);
    }
  }
  await c.end();
  console.log("All migrations applied cleanly!");
}

run();
