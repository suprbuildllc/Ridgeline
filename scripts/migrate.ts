import { Client } from '@neondatabase/serverless';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL is not set in environment!');
  process.exit(1);
}

async function runMigration() {
  console.log('Connecting to Neon Lakebase Postgres...');
  const client = new Client({ connectionString });
  await client.connect();

  try {
    // Create auth schema and dummy auth.role() function if not already present, so RLS policies don't fail
    await client.query('CREATE SCHEMA IF NOT EXISTS auth;');
    await client.query(`
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$
      BEGIN
        RETURN 'authenticated'::text;
      END;
      $$ LANGUAGE plpgsql;
    `);

    const migrationPath = path.resolve(process.cwd(), 'supabase/migrations/20260927000000_init_ridgeline_schema.sql');
    const migrationContent = fs.readFileSync(migrationPath, 'utf8');

    console.log('Executing schema migration...');
    await client.query(migrationContent);
    console.log('Migration successfully applied to Neon Lakebase Postgres!');

    // Verify tables
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log('Created tables:', tablesRes.rows.map((r: any) => r.table_name));

    const orgCount = await client.query('SELECT count(*) FROM public.organizations;');
    console.log('Organizations count:', orgCount.rows[0].count);

    const bookingsCount = await client.query('SELECT count(*) FROM public.job_bookings;');
    console.log('Bookings count:', bookingsCount.rows[0].count);
  } finally {
    await client.end();
  }
}

runMigration().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
