const express = require("express"), path = require("path"), fs = require("fs");
const { Pool } = require("pg"), bcrypt = require("bcryptjs");
const session = require("express-session"), multer = require("multer");
const { randomUUID } = require("crypto");
require("dotenv").config();

const app = express(), PORT = process.env.PORT || 3000;
const pool = new Pool({
  host: process.env.DB_HOST || "localhost", port: +(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || "cineverse_db", user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD
});
const frontDir = path.join(__dirname, "frontend"), posterDir = path.join(frontDir, "posters");
fs.mkdirSync(posterDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, posterDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage, limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(
    ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)
      ? null : new Error("Choose a JPG, PNG, WEBP or GIF image."),
    ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype)
  )
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
if (!process.env.SESSION_SECRET) { console.error("SESSION_SECRET is missing from .env"); process.exit(1); }
app.use(session({ name: "cineverse.sid", secret: process.env.SESSION_SECRET, resave: false,
  saveUninitialized: false, cookie: { httpOnly: true, secure: false, sameSite: "lax", maxAge: 2 * 60 * 60 * 1000 } }));
app.use(express.static(frontDir));

function startUserSession(req, user) {
  return new Promise((resolve, reject) => req.session.regenerate(err => {
    if (err) return reject(err);
    req.session.user = { user_id: user.user_id, email: user.email, full_name: user.full_name,
      role: user.role, date_of_birth: user.date_of_birth, phone: user.phone };
    req.session.save(err2 => err2 ? reject(err2) : resolve());
  }));
}
const requireLogin = (req, res, next) => req.session.user
  ? next() : res.status(401).json({ success: false, message: "Please log in first." });
const requireAdmin = (req, res, next) => req.session.user?.role === "admin"
  ? next() : res.status(403).json({ success: false, message: "Administrator access required." });
const profileComplete = u => Boolean(u.full_name && u.date_of_birth && u.phone);
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const movieFields = `movie_id,title,poster_path,genre,language,cast_members,director,male_lead,female_lead,supporting_1,supporting_2,plot,runtime_minutes,imdb_rating,TO_CHAR(release_date,'YYYY-MM-DD') AS release_date,status`;

// Make the new cast columns available to existing databases without deleting data.
async function migrateDatabase() {
  for (const field of ["director", "male_lead", "female_lead", "supporting_1", "supporting_2"]) {
    await pool.query(`ALTER TABLE movies ADD COLUMN IF NOT EXISTS ${field} VARCHAR(150)`);
  }
  await pool.query("ALTER TABLE movies ADD COLUMN IF NOT EXISTS runtime_minutes INTEGER");
  // Persist customer cancellation/refund events for profile history and financial reporting.
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT");
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_booking_seats_one_active_booking
    ON booking_seats(show_seat_id) WHERE is_active = TRUE`);

  // Replace any legacy unconditional unique key on a screen/date/start-time.
  // The old key also included cancelled rows, preventing another movie from
  // using that slot. The new partial index only reserves slots for scheduled shows.
  const legacyShowScheduleIndexes = await pool.query(`
    SELECT ns.nspname AS schema_name, idx.relname AS index_name, con.conname AS constraint_name
    FROM pg_index ix
    JOIN pg_class tbl ON tbl.oid = ix.indrelid
    JOIN pg_namespace tns ON tns.oid = tbl.relnamespace
    JOIN pg_class idx ON idx.oid = ix.indexrelid
    JOIN pg_namespace ns ON ns.oid = idx.relnamespace
    LEFT JOIN pg_constraint con ON con.conindid = ix.indexrelid AND con.contype = 'u'
    WHERE tns.nspname = 'public' AND tbl.relname = 'shows'
      AND ix.indisunique AND NOT ix.indisprimary
      AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
           FROM unnest(ix.indkey) WITH ORDINALITY AS key(attnum, ordinality)
           JOIN pg_attribute att ON att.attrelid = tbl.oid AND att.attnum = key.attnum
           WHERE key.ordinality <= ix.indnkeyatts)
          = ARRAY['screen_id','show_date','start_time']::text[]
  `);
  const quoteIdentifier = value => '"' + String(value).replace(/"/g, '""') + '"';
  for (const legacy of legacyShowScheduleIndexes.rows) {
    if (legacy.constraint_name) {
      await pool.query(`ALTER TABLE ${quoteIdentifier(legacy.schema_name)}.${quoteIdentifier('shows')} DROP CONSTRAINT ${quoteIdentifier(legacy.constraint_name)}`);
    } else {
      await pool.query(`DROP INDEX ${quoteIdentifier(legacy.schema_name)}.${quoteIdentifier(legacy.index_name)}`);
    }
  }
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_shows_screen_date_start_scheduled
    ON public.shows(screen_id, show_date, start_time) WHERE status = 'scheduled'`);

  // Apply the corrected cinema seating order once: Silver/Front Row,
  // Platinum/Lounge, Gold/Recliner Lounge. Existing seat numbers are preserved.
  await pool.query(`CREATE TABLE IF NOT EXISTS cineverse_schema_migrations (
    migration_key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const zoneMigration = await pool.query(
    "SELECT 1 FROM cineverse_schema_migrations WHERE migration_key=$1",
    ["seat-zones-silver-platinum-gold-v1"]
  );
  if (!zoneMigration.rowCount) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE seats SET seat_class = CASE seat_class
        WHEN 'gold' THEN 'platinum' WHEN 'platinum' THEN 'gold' ELSE seat_class END
        WHERE seat_class IN ('gold','platinum')`);
      // Move screen price labels with the physical lounge/recliner zones.
      await client.query(`UPDATE screens SET gold_price=platinum_price, platinum_price=gold_price`);
      // Reprice only seats still available; confirmed tickets retain their original purchase price.
      await client.query(`UPDATE show_seats ss SET price = CASE se.seat_class
          WHEN 'silver' THEN sc.silver_price WHEN 'platinum' THEN sc.platinum_price
          WHEN 'gold' THEN sc.gold_price ELSE ss.price END
        FROM seats se JOIN screens sc ON sc.screen_id=se.screen_id
        WHERE ss.seat_id=se.seat_id AND ss.seat_status='available'`);
      await client.query("INSERT INTO cineverse_schema_migrations(migration_key) VALUES($1)",
        ["seat-zones-silver-platinum-gold-v1"]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}

// -----------------------------------------
// Public and account APIs
// -----------------------------------------
app.get("/api/version", (_req, res) => res.json({ success: true, version: "cineverse-ui-cancel-modal-2026-10-29" }));

app.get("/api/db-test", asyncRoute(async (_req, res) => {
  const q = await pool.query("SELECT current_database() AS database_name,current_user AS database_user");
  res.json({ success: true, database: q.rows[0].database_name, user: q.rows[0].database_user });
}));

app.get("/api/movies", asyncRoute(async (_req, res) => {
  // Release date never expires a title. Only Admin status changes (inactive) or deletion remove it.
  const q = await pool.query(`SELECT ${movieFields} FROM movies WHERE status IN ('now_showing','upcoming')
    ORDER BY CASE status WHEN 'now_showing' THEN 1 ELSE 2 END,release_date NULLS LAST,title`);
  res.json({ success: true, movies: q.rows });
}));

app.post("/api/register", asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(), password = req.body.password;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== "string")
    return res.status(400).json({ success: false, message: "Enter a valid email and password." });
  if (password.length < 8 || password.length > 72)
    return res.status(400).json({ success: false, message: "Password must contain 8 to 72 characters." });
  try {
    const q = await pool.query(`INSERT INTO users(email,password_hash,role) VALUES($1,$2,'customer')
      RETURNING user_id,email,full_name,role,date_of_birth,phone`, [email, await bcrypt.hash(password, 12)]);
    await startUserSession(req, q.rows[0]);
    res.status(201).json({ success: true, requiresProfile: true, role: "customer" });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ success: false, message: "An account with this email already exists." });
    throw e;
  }
}));

app.post("/api/login", asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(), password = req.body.password;
  if (!email || typeof password !== "string") return res.status(400).json({ success: false, message: "Email and password are required." });
  const q = await pool.query(`SELECT user_id,email,password_hash,full_name,role,date_of_birth,phone FROM users WHERE email=$1`, [email]);
  const user = q.rows[0];
  if (!user || !await bcrypt.compare(password, user.password_hash))
    return res.status(401).json({ success: false, message: "Invalid email or password." });
  await startUserSession(req, user);
  res.json({ success: true, role: user.role, requiresProfile: user.role === "customer" && !profileComplete(user),
    user: { user_id: user.user_id, email: user.email, full_name: user.full_name, role: user.role } });
}));

app.get("/api/me", requireLogin, (req, res) => res.json({
  success: true, user: req.session.user, profileComplete: profileComplete(req.session.user)
}));

// Public read-only probe used by the landing page to avoid 401 errors for guests.
app.get("/api/session-status", (req, res) => {
  if (!req.session.user) return res.json({ success: true, authenticated: false, user: null, profileComplete: false });
  return res.json({ success: true, authenticated: true, user: req.session.user, profileComplete: profileComplete(req.session.user) });
});

app.post("/api/profile", requireLogin, asyncRoute(async (req, res) => {
  const u = req.session.user;
  if (u.role !== "customer") return res.status(403).json({ success: false, message: "Customer profile only." });
  const name = String(req.body.fullName || "").trim(), dob = String(req.body.dateOfBirth || "").trim(), phone = String(req.body.phone || "").trim();
  if (!name || name.length > 100) return res.status(400).json({ success: false, message: "Enter a valid name." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || !Number.isFinite(new Date(dob + "T00:00:00Z").getTime()) ||
      new Date(dob + "T00:00:00Z").toISOString().slice(0, 10) !== dob || dob > new Date().toISOString().slice(0, 10))
    return res.status(400).json({ success: false, message: "Enter a valid date of birth." });
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15 || phone.length > 20)
    return res.status(400).json({ success: false, message: "Enter a valid phone number." });
  const q = await pool.query(`UPDATE users SET full_name=$1,date_of_birth=$2,phone=$3 WHERE user_id=$4
    RETURNING user_id,email,full_name,role,date_of_birth,phone`, [name, dob, phone, u.user_id]);
  req.session.user = q.rows[0];
  res.json({ success: true, message: "Profile saved.", profileComplete: true, user: q.rows[0] });
}));

app.post("/api/logout", requireLogin, (req, res) => req.session.destroy(err => {
  if (err) return res.status(500).json({ success: false, message: "Unable to log out." });
  res.clearCookie("cineverse.sid", { httpOnly: true, sameSite: "lax", secure: false });
  res.json({ success: true });
}));

// -----------------------------------------
// Movie manager: image upload + CRUD
// -----------------------------------------
app.get("/api/admin/status", requireLogin, requireAdmin, (_req, res) =>
  res.json({ success: true, role: "admin", message: "Administrator access verified." }));

app.get("/api/admin/movies", requireLogin, requireAdmin, asyncRoute(async (_req, res) => {
  const q = await pool.query(`SELECT ${movieFields} FROM movies ORDER BY movie_id DESC`);
  res.json({ success: true, movies: q.rows });
}));

function movieData(body, previousPoster = "") {
  const title = String(body.title || "").trim();
  const genre = String(body.genre || "").trim();
  const language = String(body.language || "").trim();
  const status = String(body.status || "upcoming");
  const rating = body.imdb_rating === "" || body.imdb_rating == null ? null : Number(body.imdb_rating);
  const runtime = body.runtime_minutes === "" || body.runtime_minutes == null ? null : Number(body.runtime_minutes);
  const date = String(body.release_date || "").trim() || null;
  if (!title || title.length > 200) throw Object.assign(new Error("Movie title is required."), { status: 400 });
  if (genre.length > 100 || language.length > 50) throw Object.assign(new Error("Genre or language is too long."), { status: 400 });
  if (!Number.isInteger(runtime) || runtime < 1 || runtime > 600) throw Object.assign(new Error("Enter a valid movie runtime in minutes (1–600)."), { status: 400 });
  if (!["now_showing", "upcoming", "inactive"].includes(status)) throw Object.assign(new Error("Choose a valid movie status."), { status: 400 });
  if (rating !== null && (!Number.isFinite(rating) || rating < 0 || rating > 10 || rating * 2 !== Math.round(rating * 2)))
    throw Object.assign(new Error("IMDb rating must be between 0 and 10 in 0.5 steps."), { status: 400 });
  const parsedDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + "T00:00:00Z") : null;
  if (date && (!parsedDate || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date))
    throw Object.assign(new Error("Invalid release date."), { status: 400 });
  // Release date is descriptive metadata only. A movie remains bookable while its
  // admin-controlled status is now_showing, regardless of how old the release date is.
  return {
    title, poster_path: previousPoster, genre: genre || null, language: language || null,
    cast_members: String(body.cast_members || "").trim() || null,
    director: String(body.director || "").trim() || null,
    male_lead: String(body.male_lead || "").trim() || null,
    female_lead: String(body.female_lead || "").trim() || null,
    supporting_1: String(body.supporting_1 || "").trim() || null,
    supporting_2: String(body.supporting_2 || "").trim() || null,
    plot: String(body.plot || "").trim() || null,
    runtime_minutes: runtime, imdb_rating: rating, release_date: date, status
  };
}

app.post("/api/admin/movies", requireLogin, requireAdmin, upload.single("poster"), asyncRoute(async (req, res) => {
  const m = movieData(req.body);
  m.poster_path = req.file ? `/posters/${req.file.filename}` : String(req.body.poster_path || "").trim() || null;
  const q = await pool.query(`INSERT INTO movies(title,poster_path,genre,language,cast_members,director,male_lead,female_lead,supporting_1,supporting_2,plot,runtime_minutes,imdb_rating,release_date,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::date,$15) RETURNING ${movieFields}`,
  [m.title,m.poster_path,m.genre,m.language,m.cast_members,m.director,m.male_lead,m.female_lead,m.supporting_1,m.supporting_2,m.plot,m.runtime_minutes,m.imdb_rating,m.release_date,m.status]);
  res.status(201).json({ success: true, message: "Movie added.", movie: q.rows[0] });
}));

app.put("/api/admin/movies/:id", requireLogin, requireAdmin, upload.single("poster"), asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, message: "Invalid movie ID." });
  const old = await pool.query("SELECT poster_path FROM movies WHERE movie_id=$1", [id]);
  if (!old.rows.length) return res.status(404).json({ success: false, message: "Movie not found." });
  const m = movieData(req.body, old.rows[0].poster_path);
  m.poster_path = req.file ? `/posters/${req.file.filename}` : (String(req.body.poster_path || "").trim() || m.poster_path);
  const q = await pool.query(`UPDATE movies SET title=$1,poster_path=$2,genre=$3,language=$4,cast_members=$5,director=$6,male_lead=$7,female_lead=$8,supporting_1=$9,supporting_2=$10,plot=$11,runtime_minutes=$12,imdb_rating=$13,release_date=$14::date,status=$15
    WHERE movie_id=$16 RETURNING ${movieFields}`,
  [m.title,m.poster_path,m.genre,m.language,m.cast_members,m.director,m.male_lead,m.female_lead,m.supporting_1,m.supporting_2,m.plot,m.runtime_minutes,m.imdb_rating,m.release_date,m.status,id]);
  res.json({ success: true, message: "Movie updated.", movie: q.rows[0] });
}));

app.delete("/api/admin/movies/:id", requireLogin, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const q = await pool.query("DELETE FROM movies WHERE movie_id=$1 RETURNING movie_id", [Number(req.params.id)]);
    if (!q.rowCount) return res.status(404).json({ success: false, message: "Movie not found." });
    res.json({ success: true, message: "Movie deleted." });
  } catch (e) {
    if (e.code === "23503") return res.status(409).json({ success: false, message: "This movie has scheduled or historical shows. Mark it inactive instead." });
    throw e;
  }
}));

// -----------------------------------------
// Screens and physical seat layout
// -----------------------------------------
function intCount(v) { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null; }
function screenInput(b) {
  const name = String(b.screen_name || "").trim(), silver = intCount(b.silver_count), gold = intCount(b.gold_count), platinum = intCount(b.platinum_count);
  const prices = [Number(b.silver_price), Number(b.gold_price), Number(b.platinum_price)];
  if (!name || name.length > 50 || [silver,gold,platinum].some(x => x === null) || silver + gold + platinum < 1 || silver + gold + platinum > 100)
    throw Object.assign(new Error("Enter a screen name and valid seat counts (total 1–100)."), { status: 400 });
  if (prices.some(x => !Number.isFinite(x) || x < 0 || x > 100000))
    throw Object.assign(new Error("Seat prices must be valid non-negative amounts."), { status: 400 });
  return { name, silver, gold, platinum, capacity: silver + gold + platinum, prices };
}
function makeSeats(silver, gold, platinum) {
  const rows = []; let rowIndex = 0;
  for (const [seat_class, count] of [["silver",silver],["platinum",platinum],["gold",gold]]) {
    for (let i = 0; i < count; i++) {
      const row = rowIndex + Math.floor(i / 5), col = (i % 5) + 1;
      if (row >= 26) throw Object.assign(new Error("Maximum layout is 130 seats."), { status: 400 });
      rows.push({ seat_number: String.fromCharCode(65 + row) + col, seat_class });
    }
    rowIndex += Math.ceil(count / 5);
  }
  return rows;
}
async function insertSeats(client, screenId, layout) {
  for (const s of layout) await client.query("INSERT INTO seats(screen_id,seat_number,seat_class) VALUES($1,$2,$3)", [screenId,s.seat_number,s.seat_class]);
}
app.get("/api/admin/screens", requireLogin, requireAdmin, asyncRoute(async (_req, res) => {
  const q = await pool.query(`SELECT s.screen_id,s.screen_name,s.capacity,s.silver_price,s.gold_price,s.platinum_price,s.is_active,
    (COUNT(se.seat_id) FILTER (WHERE se.seat_class='silver'))::int AS silver_count,
    (COUNT(se.seat_id) FILTER (WHERE se.seat_class='gold'))::int AS gold_count,
    (COUNT(se.seat_id) FILTER (WHERE se.seat_class='platinum'))::int AS platinum_count
    FROM screens s LEFT JOIN seats se ON se.screen_id=s.screen_id GROUP BY s.screen_id ORDER BY s.screen_id`);
  res.json({ success: true, screens: q.rows });
}));

app.post("/api/admin/screens", requireLogin, requireAdmin, asyncRoute(async (req, res) => {
  const s = screenInput(req.body), client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q = await client.query(`INSERT INTO screens(screen_name,capacity,silver_price,gold_price,platinum_price)
      VALUES($1,$2,$3,$4,$5) RETURNING screen_id`, [s.name,s.capacity,...s.prices]);
    await insertSeats(client, q.rows[0].screen_id, makeSeats(s.silver,s.gold,s.platinum));
    await client.query("COMMIT"); res.status(201).json({ success: true, message: "Screen created." });
  } catch (e) { await client.query("ROLLBACK"); if (e.code === "23505") return res.status(409).json({ success: false, message: "Screen name already exists." }); throw e; }
  finally { client.release(); }
}));

app.put("/api/admin/screens/:id", requireLogin, requireAdmin, asyncRoute(async (req, res) => {
  const id = Number(req.params.id), s = screenInput(req.body), active = req.body.is_active !== false && req.body.is_active !== "false";
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, message: "Invalid screen ID." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const old = await client.query("SELECT * FROM screens WHERE screen_id=$1 FOR UPDATE", [id]);
    if (!old.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ success: false, message: "Screen not found." }); }
    const countQ = await client.query(`SELECT COUNT(*)::int AS n FROM shows WHERE screen_id=$1`, [id]);
    const seatsQ = await client.query(`SELECT seat_class,COUNT(*)::int AS n FROM seats WHERE screen_id=$1 GROUP BY seat_class`, [id]);
    const current = Object.fromEntries(seatsQ.rows.map(r => [r.seat_class, r.n]));
    const changed = s.silver !== (current.silver || 0) || s.gold !== (current.gold || 0) || s.platinum !== (current.platinum || 0);
    if (changed && countQ.rows[0].n > 0) { await client.query("ROLLBACK"); return res.status(409).json({ success: false, message: "Seat counts cannot change after shows have been scheduled on this screen." }); }
    await client.query(`UPDATE screens SET screen_name=$1,capacity=$2,silver_price=$3,gold_price=$4,platinum_price=$5,is_active=$6 WHERE screen_id=$7`,
      [s.name,s.capacity,...s.prices,active,id]);
    if (changed) {
      await client.query("DELETE FROM seats WHERE screen_id=$1", [id]);
      await insertSeats(client, id, makeSeats(s.silver,s.gold,s.platinum));
    }
    await client.query("COMMIT"); res.json({ success: true, message: "Screen updated." });
  } catch (e) { await client.query("ROLLBACK"); if (e.code === "23505") return res.status(409).json({ success: false, message: "Screen name already exists." }); throw e; }
  finally { client.release(); }
}));

// -----------------------------------------
// Shows: schedule, list, cancel, seat status
// -----------------------------------------
app.get("/api/admin/shows", requireLogin, requireAdmin, asyncRoute(async (_req, res) => {
  const q = await pool.query(`SELECT sh.show_id,sh.movie_id,sh.screen_id,sh.show_date,TO_CHAR(sh.show_date,'YYYY-MM-DD') AS show_date_text,
    TO_CHAR(sh.start_time,'HH12:MI:SS AM') AS start_time,TO_CHAR(sh.end_time,'HH12:MI:SS AM') AS end_time,sh.status,
    m.title AS movie_title,s.screen_name,COUNT(ss.show_seat_id)::int AS seat_count,
    (COUNT(ss.show_seat_id) FILTER (WHERE ss.seat_status='available'))::int AS available_count,
    (COUNT(ss.show_seat_id) FILTER (WHERE ss.seat_status='booked'))::int AS booked_count,
    (SELECT COUNT(*)::int FROM bookings b WHERE b.show_id=sh.show_id) AS booking_count
    FROM shows sh JOIN movies m ON m.movie_id=sh.movie_id JOIN screens s ON s.screen_id=sh.screen_id
    LEFT JOIN show_seats ss ON ss.show_id=sh.show_id GROUP BY sh.show_id,m.title,s.screen_name ORDER BY sh.show_date DESC,sh.start_time`);
  res.json({ success: true, shows: q.rows });
}));

app.post("/api/admin/shows", requireLogin, requireAdmin, asyncRoute(async (req, res) => {
  const movieId = Number(req.body.movie_id), screenId = Number(req.body.screen_id);
  const date = String(req.body.show_date || "").trim();
  const start = String(req.body.start_time || "").trim();
  const timeMatch = start.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (![movieId, screenId].every(n => Number.isInteger(n) && n > 0) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) || !timeMatch ||
      Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59 || Number(timeMatch[3]) > 59) {
    return res.status(400).json({ success: false, message: "Choose a movie, screen, date and valid start time using the time picker." });
  }
  const validDate = new Date(date + "T00:00:00Z");
  if (!Number.isFinite(validDate.getTime()) || validDate.toISOString().slice(0, 10) !== date)
    return res.status(400).json({ success: false, message: "Enter a valid show date." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const movie = await client.query("SELECT status,runtime_minutes FROM movies WHERE movie_id=$1 FOR SHARE", [movieId]);
    const screen = await client.query("SELECT * FROM screens WHERE screen_id=$1 FOR SHARE", [screenId]);
    if (!movie.rows.length || movie.rows[0].status === "inactive") throw Object.assign(new Error("Choose an active movie."), { status: 400 });
    if (!Number.isInteger(Number(movie.rows[0].runtime_minutes)) || Number(movie.rows[0].runtime_minutes) < 1)
      throw Object.assign(new Error("This movie has no valid runtime. Edit the movie and enter its runtime first."), { status: 400 });
    if (!screen.rows.length || !screen.rows[0].is_active) throw Object.assign(new Error("Choose an active screen."), { status: 400 });
    const past = await client.query("SELECT $1::date < CURRENT_DATE AS is_past", [date]);
    if (past.rows[0].is_past) throw Object.assign(new Error("Show date must be today or later."), { status: 400 });

    const [hours, minutes, seconds] = timeMatch.slice(1, 4).map(Number);
    const startTotalSeconds = hours * 3600 + minutes * 60 + seconds;
    const endTotalSeconds = startTotalSeconds + Number(movie.rows[0].runtime_minutes) * 60;
    if (endTotalSeconds >= 24 * 60 * 60) throw Object.assign(new Error("This show would end after midnight. Choose an earlier start time."), { status: 400 });
    const endHours = Math.floor(endTotalSeconds / 3600), endMinutes = Math.floor((endTotalSeconds % 3600) / 60), endSeconds = endTotalSeconds % 60;
    const end = `${String(endHours).padStart(2, "0")}:${String(endMinutes).padStart(2, "0")}:${String(endSeconds).padStart(2, "0")}`;

    const overlap = await client.query(`SELECT 1 FROM shows WHERE screen_id=$1 AND show_date=$2::date AND status='scheduled' AND start_time < $4::time AND end_time > $3::time LIMIT 1`, [screenId, date, start, end]);
    if (overlap.rowCount) throw Object.assign(new Error(`This screen already has a show overlapping ${start}–${end}. Choose another time or screen.`), { status: 409 });

    const show = await client.query(`INSERT INTO shows(movie_id,screen_id,show_date,start_time,end_time) VALUES($1,$2,$3,$4,$5) RETURNING show_id`, [movieId, screenId, date, start, end]);
    await client.query(`INSERT INTO show_seats(show_id,seat_id,price)
      SELECT $1,se.seat_id,CASE se.seat_class WHEN 'silver' THEN sc.silver_price WHEN 'platinum' THEN sc.platinum_price WHEN 'gold' THEN sc.gold_price ELSE sc.silver_price END
      FROM seats se JOIN screens sc ON sc.screen_id=se.screen_id WHERE sc.screen_id=$2`, [show.rows[0].show_id, screenId]);
    await client.query("COMMIT");
    res.status(201).json({ success: true, message: `Show scheduled from ${start} to ${end}.`, show_id: show.rows[0].show_id, end_time: end });
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === "23505") return res.status(409).json({ success: false, message: "A show already starts at this time on this screen." });
    throw e;
  } finally { client.release(); }
}));

// Delete a show from the schedule. With no booking history, remove the show and
// its generated seat rows permanently. If tickets exist, archive it as cancelled
// instead so ticket/payment history is never orphaned; the time slot is still freed.
app.delete("/api/admin/shows/:id", requireLogin, requireAdmin, asyncRoute(async (req, res) => {
  const showId = Number(req.params.id);
  if (!Number.isInteger(showId) || showId < 1)
    return res.status(400).json({ success: false, message: "Invalid show ID." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const show = await client.query("SELECT show_id,status FROM shows WHERE show_id=$1 FOR UPDATE", [showId]);
    if (!show.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Show not found. Refresh the scheduled shows list." });
    }

    const bookingCount = await client.query("SELECT COUNT(*)::int AS total FROM bookings WHERE show_id=$1", [showId]);
    const total = Number(bookingCount.rows[0].total || 0);

    if (total > 0) {
      await client.query("UPDATE shows SET status='cancelled' WHERE show_id=$1", [showId]);
      await client.query("COMMIT");
      return res.json({
        success: true,
        deleted: false,
        archived: true,
        booking_count: total,
        message: `Show removed from the active schedule. ${total} existing booking record(s) were preserved as history, and this time slot is now free.`
      });
    }

    await client.query("DELETE FROM show_seats WHERE show_id=$1", [showId]);
    await client.query("DELETE FROM shows WHERE show_id=$1", [showId]);
    await client.query("COMMIT");
    return res.json({ success: true, deleted: true, archived: false, message: "Show permanently deleted. Its time slot is now free for another movie." });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23503") {
      return res.status(409).json({ success: false, message: "This show is linked to historical records and could not be permanently deleted. Its booking history has been preserved." });
    }
    throw error;
  } finally {
    client.release();
  }
}));

app.get("/api/admin/shows/:id/seats", requireLogin, requireAdmin, asyncRoute(async (req, res) => {
  const q = await pool.query(`SELECT ss.show_seat_id,se.seat_number,se.seat_class,ss.seat_status,ss.price
    FROM show_seats ss JOIN seats se ON se.seat_id=ss.seat_id WHERE ss.show_id=$1 ORDER BY se.seat_number`, [Number(req.params.id)]);
  res.json({ success: true, seats: q.rows });
}));

// -----------------------------------------
// Counter bookings and admin booking list
// -----------------------------------------
app.get("/api/admin/bookings", requireLogin, requireAdmin, asyncRoute(async (_req, res) => {
  const q = await pool.query(`SELECT b.booking_id,b.booking_code,b.booking_type,b.booking_status,b.customer_name,b.customer_phone,b.total_amount,b.refund_amount,b.cancelled_at,b.created_at,
    m.title AS movie_title,s.screen_name,TO_CHAR(sh.show_date,'YYYY-MM-DD') AS show_date,TO_CHAR(sh.start_time,'HH24:MI') AS show_time,
    COALESCE((SELECT ARRAY_AGG(se.seat_number ORDER BY se.seat_number) FROM booking_seats bs JOIN show_seats ss ON ss.show_seat_id=bs.show_seat_id JOIN seats se ON se.seat_id=ss.seat_id WHERE bs.booking_id=b.booking_id),ARRAY[]::text[]) AS seats,
    p.payment_status
    FROM bookings b JOIN shows sh ON sh.show_id=b.show_id JOIN movies m ON m.movie_id=sh.movie_id JOIN screens s ON s.screen_id=sh.screen_id
    LEFT JOIN LATERAL (SELECT payment_status FROM payments WHERE booking_id=b.booking_id ORDER BY created_at DESC LIMIT 1) p ON TRUE
    ORDER BY b.created_at DESC`);
  res.json({ success: true, bookings: q.rows });
}));

app.get("/api/admin/shows/:id/available-seats", requireLogin, requireAdmin, asyncRoute(async (req, res) => {
  const q = await pool.query(`SELECT ss.show_seat_id,se.seat_number,se.seat_class,ss.seat_status,ss.price
    FROM show_seats ss JOIN seats se ON se.seat_id=ss.seat_id WHERE ss.show_id=$1 ORDER BY se.seat_number`, [Number(req.params.id)]);
  res.json({ success: true, seats: q.rows });
}));

app.post("/api/admin/bookings/counter", requireLogin, requireAdmin, asyncRoute(async (req, res) => {
  const showId = Number(req.body.show_id), ids = [...new Set((Array.isArray(req.body.show_seat_ids) ? req.body.show_seat_ids : []).map(Number))];
  const name = String(req.body.customer_name || "").trim(), phone = String(req.body.customer_phone || "").trim();
  if (!Number.isInteger(showId) || showId < 1 || !ids.length || ids.some(n => !Number.isInteger(n) || n < 1) || !name || name.length > 100)
    return res.status(400).json({ success: false, message: "Choose a show, available seats and customer name." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const show = await client.query("SELECT status FROM shows WHERE show_id=$1 FOR SHARE", [showId]);
    if (!show.rows.length || show.rows[0].status !== "scheduled") throw Object.assign(new Error("Show is not available for booking."), { status: 400 });
    const selected = await client.query(`SELECT show_seat_id,price FROM show_seats WHERE show_id=$1 AND show_seat_id=ANY($2::int[]) AND seat_status='available' FOR UPDATE`, [showId,ids]);
    if (selected.rows.length !== ids.length) throw Object.assign(new Error("One or more seats are no longer available. Refresh the seat list."), { status: 409 });
    const total = selected.rows.reduce((sum, r) => sum + Number(r.price), 0), code = "CV-" + randomUUID().slice(0, 8).toUpperCase();
    const b = await client.query(`INSERT INTO bookings(booking_code,show_id,user_id,booking_type,customer_name,customer_phone,booking_status,total_amount)
      VALUES($1,$2,NULL,'counter',$3,$4,'confirmed',$5) RETURNING booking_id,booking_code,total_amount`, [code,showId,name,phone || null,total]);
    for (const seat of selected.rows) await client.query("INSERT INTO booking_seats(booking_id,show_seat_id,seat_price,is_active) VALUES($1,$2,$3,TRUE)", [b.rows[0].booking_id,seat.show_seat_id,seat.price]);
    await client.query("UPDATE show_seats SET seat_status='booked' WHERE show_seat_id=ANY($1::int[])", [ids]);
    await client.query(`INSERT INTO payments(booking_id,payment_method,payment_status,amount,transaction_reference,paid_at)
      VALUES($1,'counter','successful',$2,$3,NOW())`, [b.rows[0].booking_id,total,"COUNTER-" + code]);
    await client.query("COMMIT"); res.status(201).json({ success: true, message: "Counter booking confirmed.", booking: b.rows[0] });
  } catch (e) { await client.query("ROLLBACK"); if (e.code === "23505") return res.status(409).json({ success: false, message: "One or more seats are already booked." }); throw e; }
  finally { client.release(); }
}));

// -----------------------------------------
// Revenue reports
// -----------------------------------------
app.get("/api/admin/revenue", requireLogin, requireAdmin, asyncRoute(async (_req, res) => {
  // Net revenue = collected sales minus refunds. Keep cancellations in a separate report
  // while booking/seat counts reflect currently confirmed tickets only.
  const financeCte = `WITH booking_finance AS (
    SELECT b.booking_id,b.booking_code,b.show_id,b.booking_type,b.booking_status,b.total_amount,
      COALESCE(b.refund_amount,0)::numeric(12,2) AS refund_amount,b.cancelled_at,b.created_at,sh.movie_id,
      COALESCE(pay.successful_amount,CASE WHEN b.booking_type='counter' AND b.booking_status IN ('confirmed','cancelled') THEN b.total_amount ELSE 0 END,0)::numeric(12,2) AS gross_revenue,
      (b.booking_status IN ('confirmed','cancelled') AND (b.booking_type='counter' OR pay.successful_amount IS NOT NULL)) AS revenue_eligible,
      COALESCE(pay.latest_paid_at,b.created_at) AS recognised_at,
      m.title AS movie_title,s.screen_name,TO_CHAR(sh.show_date,'YYYY-MM-DD') AS show_date_text,
      TO_CHAR(sh.start_time,'HH12:MI AM') AS show_time_text,
      b.customer_name,b.customer_phone
    FROM bookings b JOIN shows sh ON sh.show_id=b.show_id JOIN movies m ON m.movie_id=sh.movie_id
    JOIN screens s ON s.screen_id=sh.screen_id
    LEFT JOIN LATERAL (
      SELECT SUM(amount) FILTER (WHERE payment_status='successful') AS successful_amount,
        MAX(COALESCE(paid_at,created_at)) FILTER (WHERE payment_status='successful') AS latest_paid_at
      FROM payments WHERE booking_id=b.booking_id
    ) pay ON TRUE
  )`;
  const [summary, seats, byMovie, cancelled] = await Promise.all([
    pool.query(`${financeCte}
      SELECT
        GREATEST(COALESCE(SUM(gross_revenue-refund_amount) FILTER (WHERE revenue_eligible),0),0)::numeric(12,2) AS total_revenue,
        GREATEST(
          COALESCE(SUM(gross_revenue) FILTER (WHERE revenue_eligible AND
            (recognised_at AT TIME ZONE 'Asia/Kolkata')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),0)
          - COALESCE(SUM(refund_amount) FILTER (WHERE cancelled_at IS NOT NULL AND
            (cancelled_at AT TIME ZONE 'Asia/Kolkata')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),0),0
        )::numeric(12,2) AS today_revenue,
        COALESCE(SUM(gross_revenue) FILTER (WHERE revenue_eligible AND
          (recognised_at AT TIME ZONE 'Asia/Kolkata')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),0)::numeric(12,2) AS today_gross_revenue,
        COALESCE(SUM(refund_amount) FILTER (WHERE cancelled_at IS NOT NULL AND
          (cancelled_at AT TIME ZONE 'Asia/Kolkata')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),0)::numeric(12,2) AS today_refunded_amount,
        GREATEST(
          COALESCE(SUM(gross_revenue) FILTER (WHERE revenue_eligible AND
            (recognised_at AT TIME ZONE 'Asia/Kolkata')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),0)
          - COALESCE(SUM(refund_amount) FILTER (WHERE cancelled_at IS NOT NULL AND
            (cancelled_at AT TIME ZONE 'Asia/Kolkata')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),0),0
        )::numeric(12,2) AS today_profit,
        COALESCE(SUM(refund_amount) FILTER (WHERE revenue_eligible),0)::numeric(12,2) AS refunded_amount,
        COUNT(*) FILTER (WHERE revenue_eligible AND booking_status='confirmed')::int AS confirmed_bookings,
        COUNT(*) FILTER (WHERE revenue_eligible AND booking_status='cancelled')::int AS cancelled_tickets,
        COALESCE(SUM(gross_revenue) FILTER (WHERE revenue_eligible),0)::numeric(12,2) AS gross_revenue
      FROM booking_finance`),
    pool.query(`${financeCte}
      SELECT COUNT(*)::int AS seats_booked FROM booking_seats bs
      JOIN booking_finance f ON f.booking_id=bs.booking_id
      WHERE bs.is_active AND f.revenue_eligible AND f.booking_status='confirmed'`),
    pool.query(`${financeCte}, active_seats AS (
      SELECT booking_id,COUNT(*)::int AS seat_count FROM booking_seats WHERE is_active GROUP BY booking_id
    )
    SELECT m.movie_id,m.title,
      COUNT(f.booking_id) FILTER (WHERE f.revenue_eligible AND f.booking_status='confirmed')::int AS confirmed_bookings,
      COALESCE(SUM(CASE WHEN f.revenue_eligible AND f.booking_status='confirmed' THEN COALESCE(a.seat_count,0) ELSE 0 END),0)::int AS seats_booked,
      GREATEST(COALESCE(SUM(f.gross_revenue-f.refund_amount) FILTER (WHERE f.revenue_eligible),0),0)::numeric(12,2) AS revenue
    FROM movies m LEFT JOIN booking_finance f ON f.movie_id=m.movie_id
    LEFT JOIN active_seats a ON a.booking_id=f.booking_id
    GROUP BY m.movie_id,m.title ORDER BY revenue DESC,m.title`),
    pool.query(`${financeCte}
      SELECT booking_id,booking_code,movie_title,screen_name,show_date_text AS show_date,show_time_text AS show_time,
        customer_name,customer_phone,booking_type,total_amount,refund_amount,
        GREATEST(total_amount-refund_amount,0)::numeric(12,2) AS retained_amount,cancelled_at,
        COALESCE((SELECT ARRAY_AGG(se.seat_number ORDER BY se.seat_number)
          FROM booking_seats bs JOIN show_seats ss ON ss.show_seat_id=bs.show_seat_id
          JOIN seats se ON se.seat_id=ss.seat_id WHERE bs.booking_id=booking_finance.booking_id),ARRAY[]::text[]) AS seats
      FROM booking_finance WHERE booking_status='cancelled' AND revenue_eligible
      ORDER BY cancelled_at DESC NULLS LAST,created_at DESC`)
  ]);
  res.json({ success:true, summary:{...summary.rows[0],seats_booked:seats.rows[0].seats_booked}, movies:byMovie.rows, cancelled_tickets:cancelled.rows });
}));

// -----------------------------------------
// Customer ticket booking (demo checkout; no external payment gateway)
// -----------------------------------------
const requireCompleteCustomer = (req, res, next) => {
  if (req.session.user?.role !== 'customer') return res.status(403).json({ success: false, message: 'Please sign in with a customer account to book tickets.' });
  if (!profileComplete(req.session.user)) return res.status(403).json({ success: false, message: 'Complete your profile before booking tickets.', requiresProfile: true });
  next();
};

app.get('/api/booking/shows', requireLogin, requireCompleteCustomer, asyncRoute(async (req, res) => {
  const movieId = Number(req.query.movie_id);
  if (!Number.isInteger(movieId) || movieId < 1) return res.status(400).json({ success: false, message: 'Select a valid movie.' });
  // Booking eligibility is controlled by Admin status only, never by release_date.
  const movieQ = await pool.query(`SELECT ${movieFields} FROM movies WHERE movie_id=$1 AND status='now_showing'`, [movieId]);
  if (!movieQ.rowCount) return res.status(404).json({ success: false, message: 'This movie is not currently available for booking. Check the movie status in Admin → Movies.' });

  // Always compare cinema sessions using India local time, irrespective of the PostgreSQL server timezone.
  // Include today's sessions even when their start time has passed so the page can explain why they are disabled.
  const showsQ = await pool.query(`SELECT sh.show_id,sh.movie_id,sh.screen_id,TO_CHAR(sh.show_date,'YYYY-MM-DD') AS show_date,
      TO_CHAR(sh.start_time,'HH12:MI:SS AM') AS start_time,TO_CHAR(sh.end_time,'HH12:MI:SS AM') AS end_time,
      s.screen_name,COUNT(ss.show_seat_id)::int AS seat_count,
      (COUNT(ss.show_seat_id) FILTER (WHERE ss.seat_status='available'))::int AS available_count,
      ((sh.show_date + sh.start_time) > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')) AS is_future
    FROM shows sh JOIN screens s ON s.screen_id=sh.screen_id
    LEFT JOIN show_seats ss ON ss.show_id=sh.show_id
    WHERE sh.movie_id=$1 AND sh.status='scheduled' AND s.is_active=TRUE
      AND sh.show_date >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
    GROUP BY sh.show_id,s.screen_name
    ORDER BY sh.show_date,sh.start_time`, [movieId]);
  const countQ = await pool.query(`SELECT COUNT(*)::int AS scheduled_show_count
    FROM shows WHERE movie_id=$1 AND status='scheduled'`, [movieId]);
  res.json({ success: true, movie: movieQ.rows[0], shows: showsQ.rows,
    scheduled_show_count: countQ.rows[0].scheduled_show_count,
    future_show_count: showsQ.rows.filter(show => show.is_future).length });
}));

app.get('/api/booking/shows/:id/seats', requireLogin, requireCompleteCustomer, asyncRoute(async (req, res) => {
  const showId = Number(req.params.id);
  if (!Number.isInteger(showId) || showId < 1) return res.status(400).json({ success: false, message: 'Invalid show.' });
  const showQ = await pool.query(`SELECT sh.show_id FROM shows sh JOIN movies m ON m.movie_id=sh.movie_id JOIN screens s ON s.screen_id=sh.screen_id
    WHERE sh.show_id=$1 AND sh.status='scheduled' AND m.status='now_showing' AND s.is_active=TRUE
      AND (sh.show_date + sh.start_time) > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')`, [showId]);
  if (!showQ.rowCount) return res.status(404).json({ success: false, message: 'This show is no longer available. Refresh the movie schedule.' });
  const q = await pool.query(`SELECT ss.show_seat_id,se.seat_number,se.seat_class,ss.seat_status,ss.price
    FROM show_seats ss JOIN seats se ON se.seat_id=ss.seat_id WHERE ss.show_id=$1 ORDER BY LEFT(se.seat_number,1), NULLIF(SUBSTRING(se.seat_number FROM 2),'')::int`, [showId]);
  res.json({ success: true, seats: q.rows });
}));

app.post('/api/bookings', requireLogin, requireCompleteCustomer, asyncRoute(async (req, res) => {
  const showId = Number(req.body.show_id);
  const ids = [...new Set((Array.isArray(req.body.show_seat_ids) ? req.body.show_seat_ids : []).map(Number))];
  if (!Number.isInteger(showId) || showId < 1 || !ids.length || ids.some(n => !Number.isInteger(n) || n < 1))
    return res.status(400).json({ success: false, message: 'Choose a show and at least one available seat.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const show = await client.query(`SELECT sh.show_id,sh.status,m.status AS movie_status,sh.show_date,sh.start_time
      FROM shows sh JOIN movies m ON m.movie_id=sh.movie_id JOIN screens s ON s.screen_id=sh.screen_id
      WHERE sh.show_id=$1 AND s.is_active=TRUE FOR UPDATE OF sh`, [showId]);
    if (!show.rowCount || show.rows[0].status !== 'scheduled' || show.rows[0].movie_status !== 'now_showing')
      throw Object.assign(new Error('This show is no longer available for booking.'), { status: 409 });
    const future = await client.query("SELECT ($1::date + $2::time) > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') AS is_future", [show.rows[0].show_date, show.rows[0].start_time]);
    if (!future.rows[0].is_future) throw Object.assign(new Error('This show has already started. Please choose another show.'), { status: 409 });
    const selected = await client.query(`SELECT show_seat_id,price FROM show_seats
      WHERE show_id=$1 AND show_seat_id=ANY($2::int[]) AND seat_status='available' FOR UPDATE`, [showId, ids]);
    if (selected.rowCount !== ids.length) throw Object.assign(new Error('One or more seats were just booked by someone else. Refresh the seat list and try again.'), { status: 409 });
    const total = selected.rows.reduce((sum, r) => sum + Number(r.price), 0);
    const code = 'CV-' + randomUUID().slice(0, 8).toUpperCase();
    const user = await client.query('SELECT full_name,phone FROM users WHERE user_id=$1', [req.session.user.user_id]);
    if (!user.rowCount) throw Object.assign(new Error('Customer account not found.'), { status: 401 });
    const booking = await client.query(`INSERT INTO bookings(booking_code,show_id,user_id,booking_type,customer_name,customer_phone,booking_status,total_amount)
      VALUES($1,$2,$3,'online',$4,$5,'confirmed',$6) RETURNING booking_id,booking_code,total_amount`,
      [code, showId, req.session.user.user_id, user.rows[0].full_name, user.rows[0].phone, total]);
    for (const seat of selected.rows) await client.query('INSERT INTO booking_seats(booking_id,show_seat_id,seat_price,is_active) VALUES($1,$2,$3,TRUE)', [booking.rows[0].booking_id, seat.show_seat_id, seat.price]);
    await client.query("UPDATE show_seats SET seat_status='booked' WHERE show_seat_id=ANY($1::int[])", [ids]);
    await client.query(`INSERT INTO payments(booking_id,payment_method,payment_status,amount,transaction_reference,paid_at)
      VALUES($1,'card','successful',$2,$3,NOW())`, [booking.rows[0].booking_id, total, 'DEMO-' + code]);
    await client.query('COMMIT');
    res.status(201).json({ success: true, message: 'Demo booking confirmed. No real payment was processed.', booking: { ...booking.rows[0], seats: ids.length } });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ success: false, message: 'A selected seat was booked at the same time. Refresh and try again.' });
    throw e;
  } finally { client.release(); }
}));

// -----------------------------------------
// Customer booking history
// -----------------------------------------
// Customer cancellation: 50% refund for a confirmed ticket before showtime.
app.post("/api/bookings/:id/cancel", requireLogin, requireCompleteCustomer, asyncRoute(async (req, res) => {
  const bookingId = Number(req.params.id);
  if (!Number.isInteger(bookingId) || bookingId < 1) return res.status(400).json({ success:false,message:"Invalid booking reference." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q = await client.query(`SELECT b.booking_id,b.booking_status,b.booking_type,b.total_amount,b.refund_amount,
        sh.show_id,sh.show_date,sh.start_time,sh.status AS show_status
      FROM bookings b JOIN shows sh ON sh.show_id=b.show_id
      WHERE b.booking_id=$1 AND b.user_id=$2 FOR UPDATE OF b`, [bookingId,req.session.user.user_id]);
    if (!q.rowCount) throw Object.assign(new Error("Booking not found for this signed-in account. Refresh My Bookings and verify the active account before cancelling."),{status:404});
    const b=q.rows[0];
    if (b.booking_status !== "confirmed") throw Object.assign(new Error("Only confirmed tickets can be cancelled."),{status:409});
    const future=await client.query("SELECT ($1::date + $2::time) > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') AS is_future",[b.show_date,b.start_time]);
    if (!future.rows[0].is_future || b.show_status !== 'scheduled') throw Object.assign(new Error("This ticket can no longer be cancelled because the show has started or is unavailable."),{status:409});
    const refund=Number((Number(b.total_amount)*0.5).toFixed(2));
    await client.query(`UPDATE bookings SET booking_status='cancelled',refund_amount=$1,cancelled_at=NOW(),
      cancellation_reason='Customer cancellation — 50% refund' WHERE booking_id=$2`,[refund,bookingId]);
    await client.query(`UPDATE show_seats SET seat_status='available'
      WHERE show_seat_id IN (SELECT show_seat_id FROM booking_seats WHERE booking_id=$1 AND is_active=TRUE)`,[bookingId]);
    await client.query("UPDATE booking_seats SET is_active=FALSE WHERE booking_id=$1 AND is_active=TRUE",[bookingId]);
    await client.query("COMMIT");
    res.json({success:true,message:"Ticket cancelled. A 50% demo refund has been recorded.",booking_id:bookingId,
      total_amount:Number(b.total_amount),refund_amount:refund,retained_amount:Number((Number(b.total_amount)-refund).toFixed(2))});
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}));

// Customer booking history. Seat names remain visible on cancelled ticket records.
app.get("/api/bookings", requireLogin, asyncRoute(async (req, res) => {
  const q = await pool.query(`SELECT b.booking_id,b.booking_code,b.booking_status,b.booking_type,b.total_amount,
    COALESCE(b.refund_amount,0)::numeric(12,2) AS refund_amount,b.cancelled_at,b.cancellation_reason,b.created_at,
    b.customer_name,b.customer_phone,m.title AS movie_title,m.poster_path,m.genre,m.language,m.runtime_minutes,m.imdb_rating,m.plot AS movie_description,
    s.screen_name,sh.show_id,TO_CHAR(sh.show_date,'YYYY-MM-DD') AS show_date,
    TO_CHAR(sh.start_time,'HH24:MI') AS show_time,TO_CHAR(sh.end_time,'HH24:MI') AS show_end_time,sh.status AS show_status,
    COALESCE((SELECT ARRAY_AGG(se.seat_number ORDER BY se.seat_number) FROM booking_seats bs JOIN show_seats ss ON ss.show_seat_id=bs.show_seat_id JOIN seats se ON se.seat_id=ss.seat_id WHERE bs.booking_id=b.booking_id),ARRAY[]::text[]) AS seats,
    p.payment_status,p.payment_method,p.transaction_reference,
    CASE WHEN b.booking_status='cancelled' THEN 'cancelled'
      WHEN b.booking_status='failed' OR p.payment_status='failed' OR sh.status='cancelled' THEN 'failed'
      WHEN b.booking_status='confirmed' AND (sh.show_date+sh.start_time)<(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') THEN 'previous'
      ELSE 'upcoming' END AS display_category
    FROM bookings b JOIN shows sh ON sh.show_id=b.show_id JOIN movies m ON m.movie_id=sh.movie_id JOIN screens s ON s.screen_id=sh.screen_id
    LEFT JOIN LATERAL (SELECT payment_status,payment_method,transaction_reference FROM payments WHERE booking_id=b.booking_id ORDER BY created_at DESC LIMIT 1) p ON TRUE
    WHERE b.user_id=$1 ORDER BY sh.show_date DESC,sh.start_time DESC,b.created_at DESC`, [req.session.user.user_id]);
  res.json({ success:true,bookings:q.rows });
}));

// Unknown API routes return JSON rather than the default HTML "Cannot POST" page.
app.use('/api', (req, res) => res.status(404).json({
  success: false,
  message: `API endpoint not found (${req.method} ${req.originalUrl}). Make sure the project-root server.js matches the updated frontend and restart node server.js.`
}));

// -----------------------------------------
// Error handler (including upload validation)
// -----------------------------------------
app.use((err, _req, res, _next) => {
  console.error(err.message);
  const status = err.status || (err instanceof multer.MulterError ? 400 : 500);
  res.status(status).json({ success: false, message: status === 500 ? "Server error. Check the terminal for details." : err.message });
});

async function ensureAdminAccount() {
  const name = process.env.ADMIN_NAME, email = process.env.ADMIN_EMAIL?.trim().toLowerCase(), password = process.env.ADMIN_PASSWORD;
  if (!name || !email || !password) throw new Error("ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
  if (password.length < 8 || password.length > 72) throw new Error("Admin password must contain 8 to 72 characters.");
  const q = await pool.query("SELECT user_id,role FROM users WHERE email=$1", [email]);
  if (q.rowCount) {
    if (q.rows[0].role !== "admin") throw new Error("Configured admin email belongs to a non-admin account.");
    console.log("Admin account already exists."); return;
  }
  await pool.query("INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,'admin')", [name,email,await bcrypt.hash(password,12)]);
  console.log("Initial admin account created successfully.");
}

async function startServer() {
  try {
    await pool.query("SELECT 1"); await migrateDatabase(); await ensureAdminAccount();
    app.listen(PORT, () => console.log(`CINEVERSE running at http://localhost:${PORT}`));
  } catch (e) { console.error("Startup failed:", e.message); await pool.end(); process.exitCode = 1; }
}
startServer();
