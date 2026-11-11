const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';

// ─── 数据层：有 DATABASE_URL 用 PostgreSQL，否则用本地 SQLite ───
let store;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },   // 云数据库（Render / Neon / Supabase）通常需要
  });

  store = {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS scores (
          id SERIAL PRIMARY KEY,
          nickname VARCHAR(20) NOT NULL,
          score INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
    },
    async add(nickname, score) {
      await pool.query('INSERT INTO scores (nickname, score) VALUES ($1, $2)', [nickname, score]);
    },
    async top(limit = 10) {
      const result = await pool.query(
        'SELECT nickname, score, created_at FROM scores ORDER BY score DESC, created_at ASC LIMIT $1',
        [limit]
      );
      return result.rows;
    },
  };
  console.log('数据库：PostgreSQL');
} else {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, 'db.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      score INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  store = {
    async init() {},
    async add(nickname, score) {
      db.prepare('INSERT INTO scores (nickname, score, created_at) VALUES (?, ?, ?)')
        .run(nickname, score, new Date().toISOString());
    },
    async top(limit = 10) {
      return db
        .prepare('SELECT nickname, score, created_at FROM scores ORDER BY score DESC LIMIT ?')
        .all(limit);
    },
  };
  console.log('数据库：SQLite（本地文件 db.sqlite）');
}

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// 健康检查：前端用来判断当前是在线还是离线
app.get('/api/health', (req, res) => {
  res.json({ ok: true, online: true });
});

// 提交分数
app.post('/api/score', async (req, res) => {
  const { nickname, score } = req.body;

  if (!nickname || typeof nickname !== 'string' || nickname.trim().length === 0) {
    return res.status(400).json({ error: '昵称不能为空' });
  }
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) {
    return res.status(400).json({ error: '分数无效' });
  }

  try {
    await store.add(nickname.trim().slice(0, 20), Math.floor(score));
    res.json({ ok: true });
  } catch (err) {
    console.error('保存分数失败:', err.message);
    res.status(500).json({ error: '服务器保存失败' });
  }
});

// 获取 Top 10 排行榜
app.get('/api/leaderboard', async (req, res) => {
  try {
    const rows = await store.top(10);
    res.json(rows);
  } catch (err) {
    console.error('读取排行榜失败:', err.message);
    res.status(500).json({ error: '服务器读取失败' });
  }
});

// 启动
store.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Snake Game running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('数据库初始化失败:', err.message);
    process.exit(1);
  });
