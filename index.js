require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', (err) => console.error('PG Pool error:', err));

function apiKeyAuth(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ success: false, code: 401, error: 'Unauthorized' });
  }
  next();
}

// POST /category
app.post('/category', apiKeyAuth, async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) {
    return res.status(400).json({ success: false, code: 400, error: 'name is required' });
  }

  try {
    const insert = await pool.query(
      `INSERT INTO public.categories (name)
       VALUES ($1)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name`,
      [name]
    );

    if (insert.rowCount > 0) {
      return res.status(200).json({ success: true, code: 200, data: insert.rows[0] });
    }

    const existing = await pool.query(
      `SELECT id, name FROM public.categories WHERE name = $1`,
      [name]
    );

    if (existing.rowCount === 0) {
      return res.status(500).json({ success: false, code: 500, error: 'failed to upsert category' });
    }

    return res.status(200).json({ success: true, code: 200, data: existing.rows[0] });
  } catch (err) {
    console.error('POST /category error:', err);
    return res.status(500).json({ success: false, code: 500, error: 'server error' });
  }
});

// POST /items
app.post('/items', apiKeyAuth, async (req, res) => {
  const name = (req.body?.name || '').trim();
  const price = Number(req.body?.price);
  const categoryId = Number(req.body?.categoryId);
  const volumes = Array.isArray(req.body?.volumes) ? req.body.volumes : [];

  
  if (!name) return res.status(400).json({ success: false, code: 400, error: 'name is required' });
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ success: false, code: 400, error: 'price must be > 0' });
  }
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return res.status(400).json({ success: false, code: 400, error: 'categoryId must be a positive integer' });
  }
  if (!volumes.length) {
    return res.status(400).json({ success: false, code: 400, error: 'volumes must contain at least one item' });
  }

  for (const v of volumes) {
    if (!v || typeof v.value !== 'string' || !v.value.trim()) {
      return res.status(400).json({ success: false, code: 400, error: 'each volume must have non-empty "value" (string)' });
    }
    if (!Number.isFinite(Number(v.price)) || Number(v.price) <= 0) {
      return res.status(400).json({ success: false, code: 400, error: 'each volume must have price > 0' });
    }
  }

  const seenPrices = new Set();
  for (const v of volumes) {
    const p = Number(v.price).toFixed(2);
    if (seenPrices.has(p)) {
      return res.status(400).json({ success: false, code: 400, error: 'duplicate prices in volumes for this item are not allowed' });
    }
    seenPrices.add(p);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cat = await client.query('SELECT id FROM public.categories WHERE id = $1', [categoryId]);
    if (cat.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, code: 400, error: 'categoryId not found' });
    }

    let itemId;
    const existing = await client.query('SELECT id FROM public.items WHERE name = $1', [name]);
    if (existing.rowCount > 0) {
      itemId = existing.rows[0].id;
      await client.query(
        `UPDATE public.items
         SET price = $1, category_id = $2
         WHERE id = $3`,
        [price, categoryId, itemId]
      );
    } else {
      const ins = await client.query(
        `INSERT INTO public.items (name, price, category_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [name, price, categoryId]
      );
      itemId = ins.rows[0].id;
    }

    async function ensureVolumeId(value) {
      const val = value.trim();
      const found = await client.query('SELECT id FROM public.volumes WHERE value = $1', [val]);
      if (found.rowCount > 0) return found.rows[0].id;

      const created = await client.query(
        'INSERT INTO public.volumes (value) VALUES ($1) RETURNING id',
        [val]
      );
      return created.rows[0].id;
    }

    for (const v of volumes) {
      const volumeId = await ensureVolumeId(v.value);
      const volPrice = Number(v.price);

      await client.query(
        `INSERT INTO public.items_volumes (item_id, volume_id, price)
         VALUES ($1, $2, $3)
         ON CONFLICT (item_id, volume_id)
         DO UPDATE SET price = EXCLUDED.price`,
        [itemId, volumeId, volPrice]
      );
    }


    await client.query('COMMIT');

    const itemRow = await pool.query('SELECT id, name FROM public.items WHERE id = $1', [itemId]);
    const vols = await pool.query(
      `SELECT v.value, iv.price
       FROM public.items_volumes iv
       JOIN public.volumes v ON v.id = iv.volume_id
       WHERE iv.item_id = $1
       ORDER BY v.value`,
      [itemId]
    );

    return res.status(200).json({
      success: true,
      code: 200,
      data: {
        id: itemRow.rows[0].id,
        name: itemRow.rows[0].name,
        volumes: vols.rows.map(r => ({ value: r.value, price: Number(r.price) }))
      }
    });
  } catch (err) {
    console.error('POST /items error:', err);
    await client.query('ROLLBACK');
    return res.status(500).json({ success: false, code: 500, error: 'server error' });
  } finally {
    client.release();
  }
});

// GET /item/search
app.get('/item/search', apiKeyAuth, async (req, res) => {
  const q = (req.query.q ?? req.query.query ?? '').toString().trim();
  if (!q) {
    return res.status(400).json({ success: false, code: 400, error: 'query param q is required' });
  }

  const escaped = q.replace(/[%_]/g, '\\$&');
  const pattern = `%${escaped}%`;

  try {
    const cats = await pool.query(
      `SELECT id, name
       FROM public.categories
       WHERE name ILIKE $1 ESCAPE '\\'
       ORDER BY name`,
      [pattern]
    );

    const items = await pool.query(
      `SELECT DISTINCT i.id, i.name
       FROM public.items i
       LEFT JOIN public.categories c   ON c.id = i.category_id
       LEFT JOIN public.items_volumes iv ON iv.item_id = i.id
       LEFT JOIN public.volumes v      ON v.id = iv.volume_id
       WHERE i.name ILIKE $1 ESCAPE '\\'
          OR c.name ILIKE $1 ESCAPE '\\'
          OR v.value ILIKE $1 ESCAPE '\\'
       ORDER BY i.id`,
      [pattern]
    );

    return res.status(200).json({
      success: true,
      code: 200,
      data: {
        categories: cats.rows,      
        items: items.rows           
      }
    });
  } catch (err) {
    console.error('GET /item/search error:', err);
    return res.status(500).json({ success: false, code: 500, error: 'server error' });
  }
});

// GET /item/:id 
app.get('/item/:id', apiKeyAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, code: 400, error: 'invalid item id' });
  }

  try {
    const item = await pool.query(
      `SELECT id, name
       FROM public.items
       WHERE id = $1`,
      [id]
    );
    if (item.rowCount === 0) {
      return res.status(404).json({ success: false, code: 404, error: 'item not found' });
    }

    const vols = await pool.query(
      `SELECT v.value, iv.price
       FROM public.items_volumes iv
       JOIN public.volumes v ON v.id = iv.volume_id
       WHERE iv.item_id = $1
       ORDER BY v.value`,
      [id]
    );

    return res.status(200).json({
      success: true,
      code: 200,
      data: {
        id: item.rows[0].id,
        name: item.rows[0].name,
        volumes: vols.rows.map(r => ({ value: r.value, price: Number(r.price) }))
      }
    });
  } catch (err) {
    console.error('GET /item/:id error:', err);
    return res.status(500).json({ success: false, code: 500, error: 'server error' });
  }
});

// GET /items 
app.get('/items', apiKeyAuth, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name
       FROM public.items
       ORDER BY id`
    );

    return res.status(200).json({
      success: true,
      code: 200,
      data: { items: rows }
    });
  } catch (err) {
    console.error('GET /items error:', err);
    return res.status(500).json({ success: false, code: 500, error: 'server error' });
  }
});


// GET /category/:id  
app.get('/category/:id', apiKeyAuth, async (req, res) => {
  const catId = Number(req.params.id);
  if (!Number.isInteger(catId) || catId <= 0) {
    return res.status(400).json({ success: false, code: 400, error: 'invalid category id' });
  }

  try {
    const cat = await pool.query(
      `SELECT id, name FROM public.categories WHERE id = $1`,
      [catId]
    );
    if (cat.rowCount === 0) {
      return res.status(404).json({ success: false, code: 404, error: 'category not found' });
    }

    const itemsRes = await pool.query(
      `SELECT id, name
       FROM public.items
       WHERE category_id = $1
       ORDER BY id`,
      [catId]
    );

    const items = itemsRes.rows;
    const itemIds = items.map(i => i.id);

    if (itemIds.length === 0) {
      return res.status(200).json({
        success: true,
        code: 200,
        data: { category: { id: cat.rows[0].id, name: cat.rows[0].name, items: [] } }
      });
    }

    const iv = await pool.query(
      `SELECT iv.item_id, v.value, iv.price
       FROM public.items_volumes iv
       JOIN public.volumes v ON v.id = iv.volume_id
       WHERE iv.item_id = ANY($1::int[])
       ORDER BY iv.item_id, v.value`,
      [itemIds]
    );

    const volsByItem = iv.rows.reduce((acc, r) => {
      (acc[r.item_id] ??= []).push({ value: r.value, price: Number(r.price) });
      return acc;
    }, {});

    const itemsWithVols = items.map(it => ({
      id: it.id,
      name: it.name,
      volumes: volsByItem[it.id] ?? []
    }));

    return res.status(200).json({
      success: true,
      code: 200,
      data: {
        category: {
          id: cat.rows[0].id,
          name: cat.rows[0].name,
          items: itemsWithVols
        }
      }
    });
  } catch (err) {
    console.error('GET /category/:id error:', err);
    return res.status(500).json({ success: false, code: 500, error: 'server error' });
  }
});






const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Server listening on http://localhost:${port}`));
