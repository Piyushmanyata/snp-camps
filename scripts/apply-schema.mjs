import "./load-env.mjs";
import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ref = "ruklmrzpyutvefancsgo";
const pwd = process.env.SUPABASE_DB_PASSWORD;
const secret = process.env.SUPABASE_SECRET_KEY;

if (!pwd) {
  console.error("Missing SUPABASE_DB_PASSWORD");
  process.exit(1);
}

const configs = [
  {
    label: "direct",
    connectionString: `postgresql://postgres:${encodeURIComponent(pwd)}@db.${ref}.supabase.co:5432/postgres`,
  },
  {
    label: "pooler-session-aws0",
    connectionString: `postgresql://postgres.${ref}:${encodeURIComponent(pwd)}@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`,
  },
  {
    label: "pooler-tx-aws0",
    connectionString: `postgresql://postgres.${ref}:${encodeURIComponent(pwd)}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres`,
  },
  {
    label: "pooler-session-aws1",
    connectionString: `postgresql://postgres.${ref}:${encodeURIComponent(pwd)}@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`,
  },
];

async function connect() {
  for (const c of configs) {
    const client = new Client({
      connectionString: c.connectionString,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    });
    try {
      await client.connect();
      const r = await client.query(
        "select current_database() as db, current_user as u",
      );
      console.log("CONNECTED via", c.label, r.rows[0]);
      return client;
    } catch (e) {
      console.log("FAIL", c.label, String(e.message).slice(0, 140));
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

async function main() {
  const client = await connect();
  if (!client) process.exit(1);

  const db = await client.query("select current_database() as db");
  if (db.rows[0].db !== "postgres") {
    console.error("Unexpected database:", db.rows[0].db);
    process.exit(1);
  }

  // Confirm we're on the intended host (project ref in connection)
  console.log("Applying schema to project", ref, "only");

  const sqlPath = path.join(__dirname, "..", "supabase", "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");

  try {
    await client.query(sql);
    console.log("SCHEMA APPLIED OK");
  } catch (e) {
    console.error("SCHEMA ERROR:", e.message);
    process.exit(2);
  }

  const tables = await client.query(
    "select tablename from pg_tables where schemaname='public' order by 1",
  );
  console.log(
    "tables:",
    tables.rows.map((r) => r.tablename).join(", "),
  );

  // Seed a default camp if none
  const camps = await client.query("select count(*)::int as n from camps");
  if (camps.rows[0].n === 0) {
    await client.query(
      `insert into camps (name, venue, camp_date, is_active)
       values ('SNP Eye Camp', 'SIKAR BHAWAN', current_date, true)`,
    );
    console.log("Seeded active camp: SNP Eye Camp");
  }

  await client.end();

  // Create admin via Auth Admin API (secret key) — only this project URL
  if (secret) {
    const url = `https://${ref}.supabase.co`;
    const email = process.env.ADMIN_EMAIL || "admin@snp-camps.local";
    const password = process.env.ADMIN_PASSWORD || "SnpAdmin2026!";

    // list users
    const listRes = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=50`, {
      headers: {
        apikey: secret,
        Authorization: `Bearer ${secret}`,
        "X-Client-Info": "snp-setup/1.0",
      },
    });
    const list = await listRes.json();
    let user = (list.users || []).find((u) => u.email === email);

    if (!user) {
      const createRes = await fetch(`${url}/auth/v1/admin/users`, {
        method: "POST",
        headers: {
          apikey: secret,
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          "X-Client-Info": "snp-setup/1.0",
        },
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: "SNP Admin", staff_role: "admin" },
        }),
      });
      const created = await createRes.json();
      if (!createRes.ok) {
        console.error("Admin create failed:", created);
        process.exit(3);
      }
      user = created;
      console.log("Created admin auth user:", email);
    } else {
      console.log("Admin auth user already exists:", email);
    }

    // Promote profile role via SQL reconnect
    const client2 = await connect();
    await client2.query(
      `update profiles set role = 'admin', full_name = coalesce(nullif(full_name,''), 'SNP Admin'), email = $1 where id = $2`,
      [email, user.id],
    );
    // If trigger hasn't created profile yet
    await client2.query(
      `insert into profiles (id, role, full_name, email)
       values ($1, 'admin', 'SNP Admin', $2)
       on conflict (id) do update set role = 'admin', email = excluded.email`,
      [user.id, email],
    );
    const prof = await client2.query(
      `select id, role, email from profiles where id = $1`,
      [user.id],
    );
    console.log("Admin profile:", prof.rows[0]);
    await client2.end();
    console.log("LOGIN email:", email);
    console.log("LOGIN password:", password);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
