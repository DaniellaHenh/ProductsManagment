require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const { rows } = await client.query('select version(), current_database(), current_user;');
    console.log(' Connected!', rows[0]);
  } catch (err) {
    console.error(' DB connection failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
