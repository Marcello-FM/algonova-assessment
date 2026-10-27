require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'abingdanadiks123';

// In-memory fallback if Neon DB is not yet connected
let memoryParticipants = [];
let sqlClient = null;
let lastInitError = null;
let dbInitialized = false;

// Robust connection string sanitizer
function sanitizeDbUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // Strip outer quotes
  s = s.replace(/^["']+|["']+$/g, '').trim();
  // Strip DATABASE_URL= prefix if accidentally included
  if (s.startsWith('DATABASE_URL=')) {
    s = s.slice('DATABASE_URL='.length).trim();
    s = s.replace(/^["']+|["']+$/g, '').trim();
  }
  // If user copied "psql 'postgresql://...'"
  const psqlMatch = s.match(/psql\s+['"]?(postgres(?:ql)?:\/\/[^'"\s]+)['"]?/i);
  if (psqlMatch) {
    s = psqlMatch[1];
  }
  // Find URL starting with postgresql:// or postgres://
  const urlMatch = s.match(/(postgres(?:ql)?:\/\/[^\s'"]+)/i);
  if (urlMatch) {
    s = urlMatch[1];
  }
  // Ensure sslmode=require for Neon DB if not present
  if (s && s.includes('neon.tech') && !s.includes('sslmode=')) {
    s += (s.includes('?') ? '&' : '?') + 'sslmode=require';
  }
  return s.trim();
}

// Get Neon client instance
function getSql() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    lastInitError = 'DATABASE_URL environment variable is empty or undefined';
    return null;
  }
  const url = sanitizeDbUrl(raw);
  if (!url) {
    lastInitError = 'DATABASE_URL could not be parsed into a valid postgresql:// URL';
    return null;
  }
  if (!sqlClient) {
    try {
      const { neon } = require('@neondatabase/serverless');
      sqlClient = neon(url);
      lastInitError = null;
    } catch (err) {
      console.error('Failed to initialize Neon DB client:', err);
      lastInitError = err.message;
      return null;
    }
  }
  return sqlClient;
}

// Ensure participants table exists
async function ensureTable(client) {
  if (!client || typeof client !== 'function' || dbInitialized) return;
  try {
    await client`
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
    console.log('Neon DB participants table verified/created successfully.');
  } catch (err) {
    console.error('Error ensuring Neon DB table:', err);
    throw err;
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

// 1. Health & Database Diagnostic
app.get('/api/health', async (req, res) => {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    return res.json({
      status: 'warning',
      database: 'not_configured',
      message: 'DATABASE_URL belum diatur di Vercel Environment Variables. Data saat ini disimpan sementara di memori.',
      hint: 'Tambahkan DATABASE_URL di Vercel Project Settings -> Environment Variables, lalu lakukan Redeploy.',
      timestamp: new Date().toISOString()
    });
  }

  const client = getSql();
  if (!client || typeof client !== 'function') {
    return res.status(500).json({
      status: 'error',
      database: 'neon_error',
      message: 'Format DATABASE_URL tidak valid: ' + (lastInitError || 'Gagal inisialisasi client'),
      hint: 'Pastikan connection string di Vercel diawali dengan postgresql://',
      timestamp: new Date().toISOString()
    });
  }

  try {
    await ensureTable(client);
    const countResult = await client`SELECT COUNT(*)::int as count FROM participants;`;
    return res.json({
      status: 'ok',
      database: 'neon_connected',
      participantCount: countResult[0].count,
      message: 'Koneksi ke Neon DB PostgreSQL berhasil dan tabel aktif.',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    return res.status(500).json({
      status: 'error',
      database: 'neon_error',
      message: 'Gagal query ke Neon DB: ' + err.message,
      hint: 'Periksa apakah database di Neon masih aktif atau password database benar.',
      timestamp: new Date().toISOString()
    });
  }
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

    const client = getSql();

    if (client && typeof client === 'function') {
      await ensureTable(client);
      const result = await client`
        INSERT INTO participants (tanggal, nama, usia, sekolah, wa, math, coding, design, dominan)
        VALUES (${entryTanggal}, ${nama}, ${String(usia)}, ${sekolah || 'Tidak Dicantumkan'}, ${wa}, ${Number(math)}, ${Number(coding)}, ${Number(design)}, ${dominan})
        RETURNING id, created_at;
      `;
      const inserted = result[0];
      return res.json({
        success: true,
        id: inserted.id,
        storage: 'neon',
        message: 'Jawaban berhasil disimpan secara permanen ke Neon DB.'
      });
    } else {
      console.warn('DATABASE_URL is not configured or failed to initialize! Saving temporarily to memory.');
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
        message: 'PERINGATAN: DATABASE_URL belum tersambung ke Neon DB. Disimpan sementara di memori.'
      });
    }
  } catch (err) {
    console.error('Error on /api/submit:', err);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server saat menyimpan data: ' + err.message });
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
    const client = getSql();
    if (client && typeof client === 'function') {
      await ensureTable(client);
      const rows = await client`
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
    res.status(500).json({ success: false, message: 'Gagal mengambil data peserta: ' + err.message });
  }
});

// 5. Admin: Delete Single Participant
app.delete('/api/admin/participants/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const client = getSql();
    if (client && typeof client === 'function') {
      await ensureTable(client);
      await client`DELETE FROM participants WHERE id = ${id};`;
      return res.json({ success: true, message: 'Data peserta berhasil dihapus dari Neon DB.' });
    } else {
      memoryParticipants = memoryParticipants.filter(p => String(p.id) !== String(id));
      return res.json({ success: true, message: 'Data peserta berhasil dihapus.' });
    }
  } catch (err) {
    console.error('Error on DELETE /api/admin/participants/:id:', err);
    res.status(500).json({ success: false, message: 'Gagal menghapus data peserta: ' + err.message });
  }
});

// 6. Admin: Clear All Participants
app.delete('/api/admin/clear-all', requireAdmin, async (req, res) => {
  try {
    const client = getSql();
    if (client && typeof client === 'function') {
      await ensureTable(client);
      await client`TRUNCATE TABLE participants;`;
      return res.json({ success: true, message: 'Semua data peserta berhasil dihapus dari Neon DB.' });
    } else {
      memoryParticipants = [];
      return res.json({ success: true, message: 'Semua data peserta telah dihapus.' });
    }
  } catch (err) {
    console.error('Error on DELETE /api/admin/clear-all:', err);
    res.status(500).json({ success: false, message: 'Gagal membersihkan data peserta: ' + err.message });
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
