const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(path.join(__dirname, 'data', 'delcrat.db'));

db.pragma('journal_mode = WAL');
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

const songsFile = path.join(__dirname, 'data', 'songs.json');

if (fs.existsSync(songsFile)) {
  const songs = JSON.parse(fs.readFileSync(songsFile, 'utf8'));

  const insert = db.prepare(`
    INSERT OR IGNORE INTO songs
    (id, title, artist, audio, media_type, cover, status, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, 'published', ?)
  `);

  const migrate = db.transaction(items => {
    for (const song of items) {
      insert.run(
        song.id,
        song.title,
        song.artist,
        song.audio,
        song.mediaType || 'audio',
        song.cover || null,
        song.uploadedAt || new Date().toISOString()
      );
    }
  });

  migrate(songs);
}

console.log('Delcrat Music database ready.');
console.log('Published songs:', db.prepare(
  "SELECT COUNT(*) AS total FROM songs WHERE status='published'"
).get().total);

db.close();
