require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = 3000;

const musicDir = path.join(__dirname, 'public', 'music');
const dataDir = path.join(__dirname, 'data');
const songsFile = path.join(dataDir, 'songs.json');

fs.mkdirSync(musicDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'delcrat.db'));
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    bio TEXT DEFAULT '',
    role TEXT DEFAULT 'member',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    audio TEXT NOT NULL,
    media_type TEXT DEFAULT 'audio',
    cover TEXT,
    owner_id TEXT,
    status TEXT DEFAULT 'pending',
    uploaded_at TEXT NOT NULL,
    FOREIGN KEY(owner_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, song_id),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(song_id) REFERENCES songs(id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    song_id TEXT NOT NULL,
    comment TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(song_id) REFERENCES songs(id)
  );

  CREATE TABLE IF NOT EXISTS follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    follower_id TEXT NOT NULL,
    artist_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(follower_id, artist_id),
    FOREIGN KEY(follower_id) REFERENCES users(id),
    FOREIGN KEY(artist_id) REFERENCES users(id)
  );
`);


if (!fs.existsSync(songsFile)) {
  fs.writeFileSync(songsFile, '[]');
}

if (!process.env.ADMIN_USERNAME ||
    !process.env.ADMIN_PASSWORD_HASH ||
    !process.env.SESSION_SECRET) {
  console.error('Missing private configuration in .env');
  process.exit(1);
}

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
    maxAge: 30 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    return res.status(401).json({ message: 'Admin login required.' });
  }
  next();
}



const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, musicDir),
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + '.upload')
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    if (!['audio', 'cover'].includes(file.fieldname)) {
      return cb(new Error('Unexpected upload field.'));
    }
    cb(null, true);
  }
});

function detectUploadedFile(filePath, field) {
  const fd = fs.openSync(filePath, 'r');
  const b = Buffer.alloc(128);
  let n;
  try { n = fs.readSync(fd, b, 0, b.length, 0); }
  finally { fs.closeSync(fd); }

  const x = b.subarray(0, n);
  const text = x.toString('latin1');

  if (field === 'cover') {
    if (x.length >= 3 && x[0] === 0xff && x[1] === 0xd8 && x[2] === 0xff) return '.jpg';
    if (x.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
    if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return '.webp';
    return null;
  }

  if (text.startsWith('ID3') || (x.length > 1 && x[0] === 0xff && (x[1] & 0xe0) === 0xe0)) return '.mp3';
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WAVE') return '.wav';
  if (text.startsWith('fLaC')) return '.flac';
  if (text.startsWith('OggS')) return '.ogg';
  if (x.length > 1 && x[0] === 0xff && (x[1] & 0xf6) === 0xf0) return '.aac';
  if (x.length >= 16 && x.subarray(0, 4).equals(Buffer.from([0x30,0x26,0xb2,0x75]))) return '.wma';

  if (text.startsWith('RIFF') && text.slice(8, 11) === 'AVI') return '.avi';
  if (x.length >= 12 && x.subarray(4, 8).toString() === 'ftyp') {
    const brand = x.subarray(8, 12).toString();
    if (brand === 'qt  ') return '.mov';
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return '.m4a';
    return '.mp4';
  }
  if (x.length >= 4 && x.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) {
    return text.includes('webm') ? '.webm' : '.mkv';
  }
  return null;
}

function removeUploadedFiles(files) {
  for (const group of Object.values(files || {})) {
    for (const f of group) {
      if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
    }
  }
}

function readSongs() {
  return db.prepare(`
    SELECT
      id,
      title,
      artist,
      audio,
      media_type AS mediaType,
      cover,
      uploaded_at AS uploadedAt
    FROM songs
    WHERE status = 'published'
    ORDER BY uploaded_at DESC
  `).all();
}

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' ||
      typeof password !== 'string') {
    return res.status(400).json({ message: 'Enter your login details.' });
  }

  const validUser = username === process.env.ADMIN_USERNAME;
  const validPassword = await bcrypt.compare(
    password,
    process.env.ADMIN_PASSWORD_HASH
  );

  if (!validUser || !validPassword) {
    return res.status(401).json({
      message: 'Incorrect username or password.'
    });
  }

  req.session.regenerate(err => {
    if (err) {
      return res.status(500).json({ message: 'Login failed.' });
    }

    req.session.admin = true;
    res.json({ message: 'Login successful.' });
  });
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.post('/api/admin/songs', requireAdmin,
  upload.fields([
    { name: 'audio', maxCount: 1 },
    { name: 'cover', maxCount: 1 }
  ]),
  (req, res) => {
    const title = (req.body.title || '').trim();
    const artist = (req.body.artist || '').trim();
    const audio = req.files?.audio?.[0];
    const cover = req.files?.cover?.[0];

    if (!title || !artist || !audio) {
      removeUploadedFiles(req.files);
      return res.status(400).json({
        message: 'Enter the song title, artist and select a supported audio or video file.'
      });
    }

    const audioExt = detectUploadedFile(audio.path, 'audio');
    const coverExt = cover ? detectUploadedFile(cover.path, 'cover') : null;

    if (!audioExt || (cover && !coverExt)) {
      removeUploadedFiles(req.files);
      return res.status(400).json({
        message: 'Unsupported file contents. Choose a valid audio/video file and JPG, PNG or WEBP cover.'
      });
    }

    const audioName = path.basename(audio.filename, '.upload') + audioExt;
    fs.renameSync(audio.path, path.join(musicDir, audioName));
    audio.filename = audioName;

    if (cover) {
      const coverName = path.basename(cover.filename, '.upload') + coverExt;
      fs.renameSync(cover.path, path.join(musicDir, coverName));
      cover.filename = coverName;
    }



    const song = {
      id: crypto.randomUUID(),
      title,
      artist,
      audio: '/music/' + audio.filename,
      mediaType: ['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(path.extname(audio.filename).toLowerCase()) ? 'video' : 'audio',
      cover: cover ? '/music/' + cover.filename : null,
      uploadedAt: new Date().toISOString()
    };

    db.prepare(`
      INSERT INTO songs
      (id, title, artist, audio, media_type, cover, status, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, 'published', ?)
    `).run(
      song.id,
      song.title,
      song.artist,
      song.audio,
      song.mediaType,
      song.cover,
      song.uploadedAt
    );

    res.status(201).json({
      message: 'Song uploaded successfully!',
      song
    });
  }
);


app.delete('/api/admin/songs/:id', requireAdmin, (req, res) => {
  try {
    const song = db.prepare(
      'SELECT audio, cover FROM songs WHERE id = ?'
    ).get(req.params.id);

    if (!song) return res.status(404).json({ message: 'Song not found.' });

    db.prepare('DELETE FROM songs WHERE id = ?').run(req.params.id);

    for (const value of [song.audio, song.cover]) {
      if (!value) continue;

      try {
        const filename = path.basename(decodeURIComponent(value));
        const filePath = path.resolve(musicDir, filename);

        if (path.dirname(filePath) === path.resolve(musicDir)) {
          const stillUsed = db.prepare(
            'SELECT COUNT(*) AS total FROM songs WHERE audio = ? OR cover = ?'
          ).get(value, value).total;

          if (!stillUsed && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }
      } catch (fileError) {
        console.error('File cleanup warning:', fileError.message);
      }
    }

    res.json({ message: 'Song deleted successfully.' });
  } catch (error) {
    console.error('Song deletion error:', error);
    res.status(500).json({ message: 'Could not delete song.' });
  }
});

app.get('/api/songs', (req, res) => {
  const songs = readSongs();
  res.json(songs);
});

app.get('/api/admin/songs', requireAdmin, (req, res) => {
  res.json(readSongs());
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out.' });
  });
});

app.get('/api', (req, res) => {
  res.json({
    message: 'Welcome to Delcrat Music!',
    artist: 'Delcrat',
    status: 'Server is running'
  });
});


app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'File too large. Maximum size is 200 MB.'
      : err.message;

    return res.status(400).json({ message });
  }

  if (err) {
    console.error('Upload error:', err.message);
    return res.status(400).json({ message: err.message });
  }

  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Delcrat Music running on port ${PORT}`);
});
