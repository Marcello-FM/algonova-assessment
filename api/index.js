require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'abingdanadiks123';
const DATABASE_URL = process.env.DATABASE_URL;

// Helper to get Neon SQL client if configured
let sql = null;
let dbInitialized = false;

if (DATABASE_URL) {
  try {
    const { neon } = require('@neondatabase/serverless');
    sql = neon(DATABASE_URL);
  } catch (err) {
    console.error('Failed to initialize Neon DB client:', err);
  }
}

// In-memory fallback if Neon DB is not yet connected
let memoryParticipants = [];

// Ensure table exists in Neon DB
async function ensureTable() {
  if (!sql || dbInitialized) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS participants (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        tanggal VARCHAR(60),
        nama VARCHAR(150) NOT NULL,
        usia VARCHAR(10) NOT NULL,
        sekolah VARCHAR(150),
        wa VARCHAR(50) NOT NULL,
        math INT NOT NULL,
        coding INT NOT NULL,
        design INT NOT NULL,
        dominan VARCHAR(20) NOT NULL
      );
    `;
    dbInitialized = true;
    console.log('Neon DB participants table verified/created.');
  } catch (err) {
    console.error('Error ensuring Neon DB table:', err);
  }
}

// Middleware: Authenticate Admin requests
function requireAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const passHeader = req.headers['x-admin-password'];
  
  let passedPass = passHeader;
  if (!passedPass && authHeader && authHeader.startsWith('Bearer ')) {
    passedPass = authHeader.slice(7);
  }
  if (!passedPass && req.query.password) {
    passedPass = req.query.password;
  }

  if (passedPass === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ success: false, message: 'Password admin tidak valid.' });
}

// ---- ROUTES ----

// 1. Health & Status
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    database: sql ? 'neon' : 'fallback-memory',
    timestamp: new Date().toISOString()
  });
});

// 2. Submit Participant Assessment
app.post('/api/submit', async (req, res) => {
  try {
    const { nama, usia, sekolah, wa, math, coding, design, dominan, tanggal } = req.body;

    if (!nama || !usia || !wa || dominan === undefined) {
      return res.status(400).json({ success: false, message: 'Data yang dikirim tidak lengkap.' });
    }

    const entryTanggal = tanggal || new Date().toLocaleDateString('id-ID', {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });

    if (sql) {
      await ensureTable();
      const result = await sql`
        INSERT INTO participants (tanggal, nama, usia, sekolah, wa, math, coding, design, dominan)
        VALUES (${entryTanggal}, ${nama}, ${String(usia)}, ${sekolah || 'Tidak Dicantumkan'}, ${wa}, ${Number(math)}, ${Number(coding)}, ${Number(design)}, ${dominan})
        RETURNING id, created_at;
      `;
      const inserted = result[0];
      return res.json({
        success: true,
        id: inserted.id,
        storage: 'neon',
        message: 'Jawaban berhasil disimpan ke Neon DB.'
      });
    } else {
      // Fallback in-memory
      const newEntry = {
        id: Date.now(),
        created_at: new Date().toISOString(),
        tanggal: entryTanggal,
        nama,
        usia: String(usia),
        sekolah: sekolah || 'Tidak Dicantumkan',
        wa,
        math: Number(math),
        coding: Number(coding),
        design: Number(design),
        dominan
      };
      memoryParticipants.unshift(newEntry);
      return res.json({
        success: true,
        id: newEntry.id,
        storage: 'fallback-memory',
        message: 'Jawaban berhasil disimpan (fallback memori).'
      });
    }
  } catch (err) {
    console.error('Error on /api/submit:', err);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server saat menyimpan data.' });
  }
});

// 3. Admin Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({
      success: true,
      token: ADMIN_PASSWORD,
      message: 'Autentikasi berhasil.'
    });
  }
  return res.status(401).json({ success: false, message: 'Password admin salah.' });
});

// 4. Admin: Get All Participants
app.get('/api/admin/participants', requireAdmin, async (req, res) => {
  try {
    if (sql) {
      await ensureTable();
      const rows = await sql`
        SELECT id, tanggal, nama, usia, sekolah, wa, math, coding, design, dominan, created_at
        FROM participants
        ORDER BY id DESC;
      `;
      return res.json({ success: true, data: rows, storage: 'neon' });
    } else {
      return res.json({ success: true, data: memoryParticipants, storage: 'fallback-memory' });
    }
  } catch (err) {
    console.error('Error on /api/admin/participants:', err);
    res.status(500).json({ success: false, message: 'Gagal mengambil data peserta.' });
  }
});

// 5. Admin: Delete Single Participant
app.delete('/api/admin/participants/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    if (sql) {
      await ensureTable();
      await sql`DELETE FROM participants WHERE id = ${id};`;
      return res.json({ success: true, message: 'Data peserta berhasil dihapus dari Neon DB.' });
    } else {
      memoryParticipants = memoryParticipants.filter(p => String(p.id) !== String(id));
      return res.json({ success: true, message: 'Data peserta berhasil dihapus.' });
    }
  } catch (err) {
    console.error('Error on DELETE /api/admin/participants/:id:', err);
    res.status(500).json({ success: false, message: 'Gagal menghapus data peserta.' });
  }
});

// 6. Admin: Clear All Participants
app.delete('/api/admin/clear-all', requireAdmin, async (req, res) => {
  try {
    if (sql) {
      await ensureTable();
      await sql`TRUNCATE TABLE participants;`;
      return res.json({ success: true, message: 'Semua data peserta berhasil dihapus dari Neon DB.' });
    } else {
      memoryParticipants = [];
      return res.json({ success: true, message: 'Semua data peserta telah dihapus.' });
    }
  } catch (err) {
    console.error('Error on DELETE /api/admin/clear-all:', err);
    res.status(500).json({ success: false, message: 'Gagal membersihkan data peserta.' });
  }
});

// For local development execution
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server Express running on http://localhost:${PORT}`);
  });
}

// Export for Vercel Serverless Function
module.exports = app;
