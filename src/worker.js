// Sell Your Stuff: the Cloudflare Worker behind the sale site.
//
// It runs in one of two modes, picked by the MODE variable in wrangler.toml:
//   template (the default)  one sale at /, one admin at /admin signed in with ADMIN_PASSWORD
//   hosted                  many invited sellers, each with one sale at /<slug>,
//                           an owner page at /owner signed in with OWNER_PASSWORD
//
// Storage, the same in both modes apart from photo bytes:
//   DB (D1)        sellers, sales, items, offers, photo records, invites, rate limits
//                  (see migrations/0001_init.sql)
//   PHOTOS (R2)    photo bytes when this binding exists (hosted)
//   SALE_KV (KV)   photo bytes otherwise (template, so no card is needed)

const STATUSES = ['Draft', 'Available', 'Pending', 'Sold'];
const DEFAULT_SETTINGS = {
  saleName: 'My Sale',
  intro: '',
  location: '',
  currency: 'NZD',
  accent: '#2f6f5e',
  closed: false,
};
const TEMPLATE_SALE_ID = 'main';
const MAX_PHOTOS_PER_ITEM = 8;
const MAX_PHOTO_BYTES = 1_500_000;
const MAX_ITEMS_PER_SALE = 500;
const MAX_PHOTOS_PER_SALE = 1_000; // Roughly 1 GB at most, so one sale can't fill the bucket.
const MAX_JSON_BYTES = 20_000;
const SELLER_COOKIE = 'sale_session';
const OWNER_COOKIE = 'owner_session';
const SESSION_SECONDS = 60 * 60 * 12;
const ID_PATTERN = /^[a-f0-9-]{36}$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/;
const RESERVED_SLUGS = new Set([
  'admin', 'owner', 'api', 'assets', 'photos', 'signup', 'sign-up', 'login', 'log-in', 'logout',
  'signin', 'sign-in', 'signout', 'register', 'home', 'index', 'favicon', 'robots', 'sitemap',
  'static', 'public', 'www', 'mail', 'help', 'about', 'terms', 'privacy', 'support', 'settings',
  'account', 'dashboard', 'sell', 'sale', 'sales', 'new', 'cdn-cgi', 'well-known', 'null', 'undefined',
]);
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 characters, no I/O/0/1 mix-ups.

// PBKDF2-SHA256 rounds for seller passwords.
// The trade-off: more rounds make a stolen database slower to crack, but every
// round costs CPU on each sign-in and sign-up, and the free plan allows 10 ms
// of CPU per request. Measured under wrangler dev on this PC, 10,000 rounds
// took about 5 to 8 ms, 25,000 about 15 ms and 100,000 (the Workers maximum)
// 60 to 80 ms. 10,000 stays under the limit with room for the rest of the
// request. That's well below current advice (600,000), so it's backed up by
// a 10 character minimum, rate-limited sign-in and a per-user salt. Each
// seller's count is stored with their hash, so it can be raised later
// (on a paid plan, say) without breaking anyone's login.
const PBKDF2_ITERATIONS = 10_000;

// An error that should reach the browser with a specific status and message.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  // Entry point: routes each request and adds security headers to the reply.
  async fetch(request, env, ctx) {
    try {
      return withSecurityHeaders(await route(request, env, ctx));
    } catch (error) {
      if (error instanceof HttpError) {
        return withSecurityHeaders(json({ error: error.message }, error.status));
      }
      console.error(error);
      return withSecurityHeaders(json({ error: 'Something went wrong. Please try again.' }, 500));
    }
  },
};

// Says whether this deployment is the multi-seller hosted version.
function isHosted(env) {
  return env.MODE === 'hosted';
}

// Sends a request to the public, seller, owner or static file routes.
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;
  const hosted = isHosted(env);

  if (pathname.startsWith('/photos/') && method === 'GET') return getPhoto(request, env, ctx, pathname);
  if (pathname === '/api/config' && method === 'GET') return json({ mode: hosted ? 'hosted' : 'template' });
  if (pathname === '/api/sale' && method === 'GET' && !hosted) return getSale(env, null);
  if (pathname.startsWith('/api/sale/') && method === 'GET' && hosted) {
    return getSale(env, decodeURIComponent(pathname.slice('/api/sale/'.length)));
  }
  if (pathname === '/api/offers' && method === 'POST') return submitOffer(request, env, ctx);
  if (pathname === '/api/admin/login' && method === 'POST') return login(request, env);
  if (pathname.startsWith('/api/admin/')) {
    const seller = await requireSeller(request, env);
    return adminRoute(request, env, seller, pathname, method);
  }
  if (hosted) {
    if (pathname === '/api/signup' && method === 'POST') return signup(request, env);
    if (pathname === '/api/owner/login' && method === 'POST') return ownerLogin(request, env);
    if (pathname.startsWith('/api/owner/')) {
      await requireOwner(request, env);
      return ownerRoute(request, env, pathname, method);
    }
  }
  if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
  return servePage(request, env, url);
}

// Handles the signed-in seller routes. Every one is scoped to seller.saleId.
async function adminRoute(request, env, seller, pathname, method) {
  const parts = pathname.split('/').slice(3).map(decodeURIComponent);
  const [area, id] = parts;
  const saleId = seller.saleId;

  if (area === 'logout' && method === 'POST') return logout(SELLER_COOKIE, '/api/admin');
  if (area === 'data' && method === 'GET') return getAdminData(env, seller);
  if (area === 'settings' && method === 'PUT') return saveSettings(request, env, saleId);
  if (area === 'items' && !id && method === 'POST') return createItem(request, env, saleId);
  if (area === 'items' && id && method === 'PUT') return updateItem(request, env, saleId, id);
  if (area === 'items' && id && method === 'DELETE') return deleteItem(env, saleId, id);
  if (area === 'photos' && !id && method === 'POST') return uploadPhoto(request, env, saleId);
  if (area === 'photos' && id && method === 'DELETE') return deletePhoto(env, saleId, id);
  if (area === 'offers' && !id && method === 'POST') return addManualOffer(request, env, saleId);
  if (area === 'offers' && id && method === 'PATCH') return updateOffer(request, env, saleId, id);
  if (area === 'offers' && id && method === 'DELETE') return deleteOffer(env, saleId, id);
  throw new HttpError(404, 'Not found');
}

// Handles the owner's routes for invites and sellers (hosted mode only).
async function ownerRoute(request, env, pathname, method) {
  const [area, id] = pathname.split('/').slice(3).map(decodeURIComponent);

  if (area === 'logout' && method === 'POST') return logout(OWNER_COOKIE, '/api/owner');
  if (area === 'data' && method === 'GET') return getOwnerData(env);
  if (area === 'invites' && !id && method === 'POST') return createInvite(request, env);
  if (area === 'invites' && id && method === 'DELETE') return deleteInvite(env, id);
  if (area === 'sales' && id && method === 'PATCH') return setSuspended(request, env, id);
  if (area === 'sales' && id && method === 'DELETE') return deleteSale(env, id);
  throw new HttpError(404, 'Not found');
}

// Serves the static pages, mapping each mode's addresses onto the right file.
async function servePage(request, env, url) {
  const { pathname } = url;
  const page = (path) => env.ASSETS.fetch(new Request(new URL(path, url), { headers: request.headers }));
  const hostedOnly = /^\/(home|owner|signup)(\.html)?$/;

  if (!isHosted(env)) {
    if (hostedOnly.test(pathname)) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  }

  // Hosted: the root is the short "what is this" page, never a list of sales.
  if (pathname === '/') return page('/home');
  if (pathname === '/login') return Response.redirect(new URL('/admin', url), 302);
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 2 && segments[1] === 'admin' && SLUG_PATTERN.test(segments[0])) {
    return Response.redirect(new URL('/admin', url), 302);
  }
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404) return response;
  // Anything shaped like a slug gets the sale page, which asks the API for that sale.
  if (segments.length === 1 && SLUG_PATTERN.test(segments[0]) && !RESERVED_SLUGS.has(segments[0])) {
    if (pathname.endsWith('/')) return Response.redirect(new URL(`/${segments[0]}`, url), 301);
    return page('/');
  }
  return response;
}

// Builds a JSON response that browsers and caches won't store.
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

// Adds headers that stop injected scripts, framing and content sniffing.
function withSecurityHeaders(response) {
  const secured = new Response(response.body, response);
  secured.headers.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  secured.headers.set('X-Content-Type-Options', 'nosniff');
  secured.headers.set('Referrer-Policy', 'same-origin');
  return secured;
}

// Reads a JSON request body, refusing anything oversized or malformed.
async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new HttpError(415, 'Send this as JSON.');
  const raw = await request.text();
  if (raw.length > MAX_JSON_BYTES) throw new HttpError(413, 'That is too long.');
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  } catch {
    // Falls through to the shared error below.
  }
  throw new HttpError(400, 'That request could not be read.');
}

// Trims a value to clean text with a maximum length.
function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

// Turns a form value into a money amount, or null when it's blank.
function cleanMoney(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) {
    throw new HttpError(400, `${label} needs to be a valid amount.`);
  }
  return Math.round(amount * 100) / 100;
}

// Returns the current time as an ISO string, used for created and offer dates.
function now() {
  return new Date().toISOString();
}

// Builds a "?, ?, ?" list for an IN (...) clause with this many values.
function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

// ---------- Rows to API shapes ----------

// Merges saved settings JSON over the defaults.
function parseSettings(raw) {
  let saved = {};
  try {
    saved = raw ? JSON.parse(raw) : {};
  } catch {
    // Bad JSON falls back to the defaults.
  }
  return { ...DEFAULT_SETTINGS, ...saved };
}

// Turns an items table row into the shape the pages use.
function itemFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    price: row.price,
    wasPrice: row.was_price,
    category: row.category,
    condition: row.condition,
    description: row.description,
    status: row.status,
    photos: JSON.parse(row.photos || '[]'),
  };
}

// Turns an offers table row into the shape the admin page uses. key is the offer id.
function offerFromRow(row) {
  return {
    key: row.id,
    itemId: row.item_id,
    itemTitle: row.item_title,
    name: row.name,
    email: row.email,
    amount: row.amount,
    message: row.message,
    source: row.source,
    date: row.date,
    winner: row.winner === 1,
    paid: row.paid === 1,
    pickedUp: row.picked_up === 1,
  };
}

// ---------- Loading a sale ----------

// Finds a public sale: the template sale, or a hosted one by slug that isn't suspended.
// Also returns the seller's email for offer alerts. Null when there's no such sale.
async function findPublicSale(env, slug) {
  if (!isHosted(env)) {
    const row = await env.DB.prepare('SELECT id, settings FROM sales WHERE id = ?').bind(TEMPLATE_SALE_ID).first();
    return { id: TEMPLATE_SALE_ID, settings: parseSettings(row?.settings), email: null };
  }
  if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) return null;
  const row = await env.DB.prepare(
    `SELECT s.id, s.settings, u.email FROM sales s JOIN sellers u ON u.id = s.seller_id
     WHERE s.slug = ? AND s.suspended = 0`,
  ).bind(slug).first();
  return row ? { id: row.id, settings: parseSettings(row.settings), email: row.email } : null;
}

// Loads a sale's settings.
async function loadSettings(env, saleId) {
  const row = await env.DB.prepare('SELECT settings FROM sales WHERE id = ?').bind(saleId).first();
  return parseSettings(row?.settings);
}

// Loads every item in one sale, newest first.
async function loadItems(env, saleId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM items WHERE sale_id = ? ORDER BY created_at DESC, rowid DESC',
  ).bind(saleId).all();
  return results.map(itemFromRow);
}

// Loads one item, but only if it belongs to this sale.
async function loadItem(env, saleId, id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ? AND sale_id = ?').bind(id, saleId).first();
  return row ? itemFromRow(row) : null;
}

// Loads every offer in one sale, newest first.
async function loadOffers(env, saleId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM offers WHERE sale_id = ? ORDER BY date DESC',
  ).bind(saleId).all();
  return results.map(offerFromRow);
}

// Returns the public sale page data, leaving out draft products.
async function getSale(env, slug) {
  const sale = await findPublicSale(env, slug);
  if (!sale) throw new HttpError(404, "There's no sale at this address.");
  const items = await loadItems(env, sale.id);
  return json({ settings: sale.settings, items: items.filter((item) => item.status !== 'Draft') });
}

// ---------- Photos ----------

// Stores photo bytes in R2 when it's bound, otherwise in KV.
async function putPhotoBytes(env, id, buffer, type) {
  if (env.PHOTOS) return env.PHOTOS.put(`photos/${id}`, buffer, { httpMetadata: { contentType: type } });
  if (env.SALE_KV) return env.SALE_KV.put(`photo:${id}`, buffer, { metadata: { type } });
  throw new HttpError(503, 'Photo storage is not set up.');
}

// Reads photo bytes from R2 or KV. Returns null when they're gone.
async function getPhotoBytes(env, id) {
  if (env.PHOTOS) {
    const object = await env.PHOTOS.get(`photos/${id}`);
    return object ? object.body : null;
  }
  if (env.SALE_KV) return env.SALE_KV.get(`photo:${id}`, 'arrayBuffer');
  return null;
}

// Deletes the bytes for a list of photos from R2 or KV.
async function deletePhotoBytes(env, ids) {
  if (!ids.length) return;
  if (env.PHOTOS) {
    for (let i = 0; i < ids.length; i += 1000) {
      await env.PHOTOS.delete(ids.slice(i, i + 1000).map((id) => `photos/${id}`));
    }
  } else if (env.SALE_KV) {
    await Promise.all(ids.map((id) => env.SALE_KV.delete(`photo:${id}`)));
  }
}

// Removes photo records owned by this sale, then their bytes. Ids it doesn't own are ignored.
async function removePhotos(env, saleId, ids) {
  if (!ids.length) return;
  const { results } = await env.DB.prepare(
    `DELETE FROM photos WHERE sale_id = ? AND id IN (${placeholders(ids.length)}) RETURNING id`,
  ).bind(saleId, ...ids).all();
  await deletePhotoBytes(env, results.map((row) => row.id));
}

// Serves a product photo, using Cloudflare's cache to save on reads.
// Photos from suspended sales aren't served (though a cached copy can linger for a day).
async function getPhoto(request, env, ctx, pathname) {
  const id = pathname.slice('/photos/'.length);
  if (!ID_PATTERN.test(id)) throw new HttpError(404, 'Not found');
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const record = await env.DB.prepare(
    `SELECT p.type FROM photos p JOIN sales s ON s.id = p.sale_id WHERE p.id = ? AND s.suspended = 0`,
  ).bind(id).first();
  if (!record) throw new HttpError(404, 'Not found');
  const body = await getPhotoBytes(env, id);
  if (!body) throw new HttpError(404, 'Not found');
  const response = new Response(body, {
    headers: {
      'Content-Type': record.type,
      // One day, so a deleted photo drops out of caches soon after.
      'Cache-Control': 'public, max-age=86400',
    },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

// Checks a file's first bytes really are a WebP or JPEG image.
function photoTypeOf(bytes) {
  const header = String.fromCharCode(...bytes.slice(0, 12));
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

// Stores one photo that the admin page has already resized.
async function uploadPhoto(request, env, saleId) {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is too large.');
  const type = photoTypeOf(new Uint8Array(buffer));
  if (!type) throw new HttpError(415, 'Photos need to be WebP or JPEG.');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE sale_id = ?').bind(saleId).first('n');
  if (count >= MAX_PHOTOS_PER_SALE) throw new HttpError(409, `A sale can have up to ${MAX_PHOTOS_PER_SALE} photos.`);
  const id = crypto.randomUUID();
  await putPhotoBytes(env, id, buffer, type);
  await env.DB.prepare('INSERT INTO photos (id, sale_id, type, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, saleId, type, now()).run();
  return json({ id }, 201);
}

// Deletes a photo that was uploaded but never saved onto a product.
async function deletePhoto(env, saleId, id) {
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'That photo is not valid.');
  const items = await loadItems(env, saleId);
  if (items.some((item) => item.photos.includes(id))) throw new HttpError(409, 'That photo is in use.');
  await removePhotos(env, saleId, [id]);
  return json({ ok: true });
}

// Keeps only the photo ids that belong to this sale, so nobody can borrow another seller's photo.
async function ownedPhotoIds(env, saleId, ids) {
  if (!ids.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT id FROM photos WHERE sale_id = ? AND id IN (${placeholders(ids.length)})`,
  ).bind(saleId, ...ids).all();
  const owned = new Set(results.map((row) => row.id));
  return ids.filter((id) => owned.has(id));
}

// ---------- Offers ----------

// Stores a buyer's offer and emails the seller when email is set up.
async function submitOffer(request, env, ctx) {
  const body = await readJson(request);
  // Bots fill in this hidden field, so pretend it worked and store nothing.
  if (body.website) return json({ ok: true });

  if (await isRateLimited(request, env, 'offer', 5)) {
    throw new HttpError(429, 'Too many offers from here. Please try again later.');
  }

  const sale = await findPublicSale(env, body.slug);
  if (!sale) throw new HttpError(404, "There's no sale at this address.");
  if (sale.settings.closed) throw new HttpError(409, 'This sale has closed.');
  const item = await loadItem(env, sale.id, body.itemId);
  if (!item || item.status === 'Draft') throw new HttpError(404, 'That item is no longer listed.');
  if (item.status === 'Sold') throw new HttpError(409, 'That item has already sold.');

  const offer = buildOffer(body, item, 'Website');
  if (!EMAIL_PATTERN.test(offer.email)) throw new HttpError(400, 'Please enter a valid email address.');
  await insertOffer(env, sale.id, offer);
  await countAttempt(request, env, 'offer', 3600, ctx);
  ctx.waitUntil(sendOfferEmail(env, offer, sale).catch((error) => console.error(error)));
  return json({ ok: true });
}

// Validates shared offer fields and builds the record to store.
function buildOffer(body, item, source) {
  const name = cleanText(body.name, 100);
  if (!name) throw new HttpError(400, 'Please add a name.');
  return {
    key: crypto.randomUUID(),
    itemId: item.id,
    itemTitle: item.title,
    name,
    email: cleanText(body.email, 200),
    amount: cleanMoney(body.amount, 'The offer'),
    message: cleanText(body.message, 2000),
    source,
    date: now(),
    winner: false,
    paid: false,
    pickedUp: false,
  };
}

// Saves a new offer under the given sale.
function insertOffer(env, saleId, offer) {
  return env.DB.prepare(
    `INSERT INTO offers (id, sale_id, item_id, item_title, name, email, amount, message, source, date, winner, paid, picked_up)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
  ).bind(offer.key, saleId, offer.itemId, offer.itemTitle, offer.name, offer.email, offer.amount,
    offer.message, offer.source, offer.date).run();
}

// Sends the optional new-offer email through Resend.
// Template mode mails NOTIFY_EMAIL. Hosted mode mails the seller's own address.
async function sendOfferEmail(env, offer, sale) {
  const to = isHosted(env) ? sale.email : env.NOTIFY_EMAIL;
  if (!env.RESEND_API_KEY || !env.SENDER_EMAIL || !to) return;
  const { settings } = sale;
  const amount = offer.amount === null ? 'No amount given' : `${offer.amount} ${settings.currency}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.SENDER_EMAIL,
      to,
      reply_to: offer.email,
      subject: `New offer: ${offer.itemTitle}`,
      text: `Sale: ${settings.saleName}\nItem: ${offer.itemTitle}\nName: ${offer.name}\nEmail: ${offer.email}\nOffer: ${amount}\n\n${offer.message}`,
    }),
  });
  if (!response.ok) console.error('Offer email failed', response.status);
}

// Records an offer the seller heard about somewhere else, like a text message.
async function addManualOffer(request, env, saleId) {
  const body = await readJson(request);
  const item = await loadItem(env, saleId, body.itemId);
  if (!item) throw new HttpError(404, 'That item no longer exists.');
  const offer = buildOffer(body, item, cleanText(body.source, 40) || 'Added by seller');
  await insertOffer(env, saleId, offer);
  return json(offer, 201);
}

// Updates an offer's amount, winner, paid or picked-up details.
async function updateOffer(request, env, saleId, id) {
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'That offer is not valid.');
  const body = await readJson(request);
  const row = await env.DB.prepare('SELECT * FROM offers WHERE id = ? AND sale_id = ?').bind(id, saleId).first();
  if (!row) throw new HttpError(404, 'That offer no longer exists.');
  const offer = offerFromRow(row);
  if ('amount' in body) offer.amount = cleanMoney(body.amount, 'The offer');
  if ('paid' in body) offer.paid = body.paid === true;
  if ('pickedUp' in body) offer.pickedUp = body.pickedUp === true;
  if ('winner' in body) {
    offer.winner = body.winner === true;
    if (offer.winner) await chooseWinner(env, saleId, offer);
  }
  await env.DB.prepare(
    'UPDATE offers SET amount = ?, paid = ?, picked_up = ?, winner = ? WHERE id = ? AND sale_id = ?',
  ).bind(offer.amount, offer.paid ? 1 : 0, offer.pickedUp ? 1 : 0, offer.winner ? 1 : 0, id, saleId).run();
  return json(offer);
}

// Clears any previous winner on the item and marks an available item as pending.
async function chooseWinner(env, saleId, winner) {
  await env.DB.batch([
    env.DB.prepare('UPDATE offers SET winner = 0 WHERE sale_id = ? AND item_id = ? AND id != ? AND winner = 1')
      .bind(saleId, winner.itemId, winner.key),
    env.DB.prepare("UPDATE items SET status = 'Pending' WHERE id = ? AND sale_id = ? AND status = 'Available'")
      .bind(winner.itemId, saleId),
  ]);
}

// Deletes one offer, which is handy for spam.
async function deleteOffer(env, saleId, id) {
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'That offer is not valid.');
  const result = await env.DB.prepare('DELETE FROM offers WHERE id = ? AND sale_id = ?').bind(id, saleId).run();
  if (!result.meta.changes) throw new HttpError(404, 'That offer no longer exists.');
  return json({ ok: true });
}

// ---------- Rate limiting ----------

// Builds the key that counts attempts from one visitor, without storing their IP.
async function rateKey(request, bucket) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  return `${bucket}:${await sha256Hex(`${bucket}:${ip}`, 24)}`;
}

// Checks whether a visitor has used up their attempts.
async function isRateLimited(request, env, bucket, limit) {
  const count = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ? AND expires_at > ?')
    .bind(await rateKey(request, bucket), Math.floor(Date.now() / 1000)).first('count');
  return (count || 0) >= limit;
}

// Records one attempt. The window starts at the first attempt and lasts the given seconds.
// Now and then it also clears out expired counters so the table stays small.
async function countAttempt(request, env, bucket, seconds, ctx) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, expires_at) VALUES (?1, 1, ?2)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN expires_at <= ?3 THEN 1 ELSE count + 1 END,
       expires_at = CASE WHEN expires_at <= ?3 THEN ?2 ELSE expires_at END`,
  ).bind(await rateKey(request, bucket), nowSeconds + seconds, nowSeconds).run();
  if (Math.random() < 0.05) {
    const cleanup = env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(nowSeconds).run();
    if (ctx) ctx.waitUntil(cleanup);
    else await cleanup;
  }
}

// ---------- Crypto helpers ----------

// Turns bytes into base64 text.
function toBase64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

// Turns base64 text back into bytes.
function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

// Returns the SHA-256 of some text as hex, optionally cut to a number of characters.
async function sha256Hex(text, length = 64) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

// Compares two strings without leaking how much of them matched.
async function safeEqual(a, b) {
  const encoder = new TextEncoder();
  const [first, second] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(first, second);
}

// Hashes a password with PBKDF2-SHA256. See PBKDF2_ITERATIONS for the cost trade-off.
async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

// Checks a password against a stored seller row, in constant time.
async function verifyPassword(password, row) {
  const actual = await hashPassword(password, fromBase64(row.password_salt), row.password_iterations);
  const expected = fromBase64(row.password_hash);
  return actual.length === expected.length && crypto.subtle.timingSafeEqual(actual, expected);
}

// ---------- Sessions ----------

// Picks the secret that signs session cookies. Changing it signs everyone out.
function signingSecret(env) {
  if (isHosted(env)) return env.SESSION_SECRET || env.OWNER_PASSWORD;
  return env.ADMIN_PASSWORD;
}

// Creates the HMAC key for signing or checking session cookies.
function sessionKey(env, usages) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`session:${signingSecret(env)}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

// Builds a signed HttpOnly cookie. The payload says who it's for and when it expires,
// e.g. "seller:<id>:<expires>", so a seller cookie can never pass as an owner one.
async function sessionCookie(env, name, path, kind, subject) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `${kind}:${subject}:${expires}`;
  const key = await sessionKey(env, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const token = `${payload}.${toBase64(signature)}`;
  return `${name}=${encodeURIComponent(token)}; Path=${path}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

// Checks a session cookie and returns its subject, or throws a 401.
async function readSession(request, env, name, kind) {
  const denied = new HttpError(401, 'Please sign in.');
  if (!signingSecret(env)) throw denied;
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.split(/;\s*/).find((part) => part.startsWith(`${name}=`));
  if (!match) throw denied;
  const token = decodeURIComponent(match.slice(name.length + 1));
  const dot = token.lastIndexOf('.');
  if (dot < 0) throw denied;
  const payload = token.slice(0, dot);
  const [tokenKind, subject, expires] = payload.split(':');
  if (tokenKind !== kind || !subject || !(Number(expires) > Date.now() / 1000)) throw denied;
  try {
    const key = await sessionKey(env, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, fromBase64(token.slice(dot + 1)), new TextEncoder().encode(payload));
    if (!valid) throw denied;
  } catch {
    throw denied;
  }
  return subject;
}

// Signs someone out by clearing a cookie.
function logout(name, path) {
  const cookie = `${name}=; Path=${path}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// Stops the request unless it carries a valid seller session, and says which sale it's for.
// Template: the one sale. Hosted: the seller's own sale, looked up fresh so a deleted
// or suspended seller is shut out straight away.
async function requireSeller(request, env) {
  if (!isHosted(env)) {
    await readSession(request, env, SELLER_COOKIE, 'admin');
    return { saleId: TEMPLATE_SALE_ID, slug: null, email: null };
  }
  const sellerId = await readSession(request, env, SELLER_COOKIE, 'seller');
  const row = await env.DB.prepare(
    `SELECT u.email, s.id AS sale_id, s.slug, s.suspended FROM sellers u JOIN sales s ON s.seller_id = u.id
     WHERE u.id = ?`,
  ).bind(sellerId).first();
  if (!row) throw new HttpError(401, 'Please sign in.');
  if (row.suspended) throw new HttpError(403, 'This sale has been paused. Get in touch with whoever invited you.');
  return { saleId: row.sale_id, slug: row.slug, email: row.email };
}

// Signs a seller in. Template checks ADMIN_PASSWORD; hosted checks email and password.
async function login(request, env) {
  if (await isRateLimited(request, env, 'login', 10)) {
    throw new HttpError(429, 'Too many tries. Please wait 15 minutes.');
  }
  const body = await readJson(request);
  const password = String(body.password || '').slice(0, 200);

  if (!isHosted(env)) {
    if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Set ADMIN_PASSWORD in Cloudflare first.');
    if (!(await safeEqual(password, env.ADMIN_PASSWORD))) {
      await countAttempt(request, env, 'login', 900);
      throw new HttpError(401, 'That password is not right.');
    }
    // Make sure the one sale exists before anything is added to it.
    await env.DB.prepare('INSERT OR IGNORE INTO sales (id, settings, created_at) VALUES (?, ?, ?)')
      .bind(TEMPLATE_SALE_ID, '{}', now()).run();
    const cookie = await sessionCookie(env, SELLER_COOKIE, '/api/admin', 'admin', 'main');
    return json({ ok: true }, 200, { 'Set-Cookie': cookie });
  }

  if (!signingSecret(env)) throw new HttpError(503, 'Set OWNER_PASSWORD in Cloudflare first.');
  const email = cleanText(body.email, 200).toLowerCase();
  const row = email
    ? await env.DB.prepare(
      `SELECT u.*, s.suspended FROM sellers u JOIN sales s ON s.seller_id = u.id WHERE u.email = ?`,
    ).bind(email).first()
    : null;
  // Hash even when the email is unknown, so the reply time doesn't give that away.
  const valid = row
    ? await verifyPassword(password, row)
    : (await hashPassword(password, new Uint8Array(16), PBKDF2_ITERATIONS), false);
  if (!valid) {
    await countAttempt(request, env, 'login', 900);
    throw new HttpError(401, "That email and password don't match.");
  }
  if (row.suspended) throw new HttpError(403, 'This sale has been paused. Get in touch with whoever invited you.');
  const cookie = await sessionCookie(env, SELLER_COOKIE, '/api/admin', 'seller', row.id);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// ---------- Hosted sign-up ----------

// Tidies an invite code so dashes, spaces and lowercase don't matter.
function normaliseCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
}

// Creates a seller account and their sale from a one-time invite code.
async function signup(request, env) {
  if (!signingSecret(env)) throw new HttpError(503, 'Set OWNER_PASSWORD in Cloudflare first.');
  if (await isRateLimited(request, env, 'signup', 10)) {
    throw new HttpError(429, 'Too many tries. Please wait an hour.');
  }
  await countAttempt(request, env, 'signup', 3600);
  const body = await readJson(request);

  const email = cleanText(body.email, 200).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const saleName = cleanText(body.saleName, 80);
  const slug = cleanText(body.slug, 40).toLowerCase();
  const code = normaliseCode(body.code);
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (password.length < 10 || password.length > 200) throw new HttpError(400, 'Your password needs at least 10 characters.');
  if (!saleName) throw new HttpError(400, 'Please give your sale a name.');
  if (!SLUG_PATTERN.test(slug) || slug.includes('--')) {
    throw new HttpError(400, 'Your link can use lowercase letters, numbers and single hyphens, 3 to 40 characters.');
  }
  if (RESERVED_SLUGS.has(slug)) throw new HttpError(409, 'That link is taken. Try another one.');

  // Cheap checks first, so a bad code never costs a password hash.
  const codeHash = await sha256Hex(`invite:${code}`);
  const invite = code
    ? await env.DB.prepare('SELECT id FROM invites WHERE code_hash = ? AND used_at IS NULL').bind(codeHash).first()
    : null;
  if (!invite) throw new HttpError(400, "That invite code isn't valid, or it's already been used.");
  const [emailTaken, slugTaken] = await Promise.all([
    env.DB.prepare('SELECT 1 AS x FROM sellers WHERE email = ?').bind(email).first(),
    env.DB.prepare('SELECT 1 AS x FROM sales WHERE slug = ?').bind(slug).first(),
  ]);
  if (emailTaken) throw new HttpError(409, 'There is already an account with that email. Try signing in.');
  if (slugTaken) throw new HttpError(409, 'That link is taken. Try another one.');

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
  const sellerId = crypto.randomUUID();
  const saleId = crypto.randomUUID();
  const created = now();
  const settings = JSON.stringify({ ...DEFAULT_SETTINGS, saleName });

  // One transaction. Each step only happens if the invite is still unused, so two
  // people racing with the same code can't both get in.
  let results;
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sellers (id, email, password_hash, password_salt, password_iterations, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM invites WHERE id = ? AND used_at IS NULL)`,
      ).bind(sellerId, email, toBase64(hash), toBase64(salt), PBKDF2_ITERATIONS, created, invite.id),
      env.DB.prepare(
        `INSERT INTO sales (id, seller_id, slug, settings, suspended, created_at)
         SELECT ?, ?, ?, ?, 0, ? WHERE EXISTS (SELECT 1 FROM sellers WHERE id = ?)`,
      ).bind(saleId, sellerId, slug, settings, created, sellerId),
      env.DB.prepare(
        `UPDATE invites SET used_at = ?, seller_id = ? WHERE id = ? AND used_at IS NULL
         AND EXISTS (SELECT 1 FROM sellers WHERE id = ?)`,
      ).bind(created, sellerId, invite.id, sellerId),
    ]);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      throw new HttpError(409, 'That email or link was just taken. Try another one.');
    }
    throw error;
  }
  if (!results[0].meta.changes) throw new HttpError(400, "That invite code isn't valid, or it's already been used.");

  const cookie = await sessionCookie(env, SELLER_COOKIE, '/api/admin', 'seller', sellerId);
  return json({ ok: true, slug }, 201, { 'Set-Cookie': cookie });
}

// ---------- Owner (hosted) ----------

// Signs the owner in with OWNER_PASSWORD.
async function ownerLogin(request, env) {
  if (!env.OWNER_PASSWORD) throw new HttpError(503, 'Set OWNER_PASSWORD in Cloudflare first.');
  if (await isRateLimited(request, env, 'owner', 10)) {
    throw new HttpError(429, 'Too many tries. Please wait 15 minutes.');
  }
  const body = await readJson(request);
  if (!(await safeEqual(String(body.password || ''), env.OWNER_PASSWORD))) {
    await countAttempt(request, env, 'owner', 900);
    throw new HttpError(401, 'That password is not right.');
  }
  const cookie = await sessionCookie(env, OWNER_COOKIE, '/api/owner', 'owner', 'owner');
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// Stops the request unless it carries a valid owner session.
async function requireOwner(request, env) {
  if (!env.OWNER_PASSWORD) throw new HttpError(401, 'Please sign in.');
  await readSession(request, env, OWNER_COOKIE, 'owner');
}

// Returns the invites and every seller's sale for the owner page.
async function getOwnerData(env) {
  const [invites, sales] = await Promise.all([
    env.DB.prepare(
      `SELECT i.id, i.hint, i.note, i.created_at, i.used_at, u.email AS used_by
       FROM invites i LEFT JOIN sellers u ON u.id = i.seller_id ORDER BY i.created_at DESC`,
    ).all(),
    env.DB.prepare(
      `SELECT s.id, s.slug, s.settings, s.suspended, s.created_at, u.email,
         (SELECT COUNT(*) FROM items i WHERE i.sale_id = s.id) AS item_count,
         (SELECT COUNT(*) FROM offers o WHERE o.sale_id = s.id) AS offer_count
       FROM sales s JOIN sellers u ON u.id = s.seller_id ORDER BY s.created_at DESC`,
    ).all(),
  ]);
  return json({
    invites: invites.results.map((row) => ({
      id: row.id, hint: row.hint, note: row.note, createdAt: row.created_at, usedAt: row.used_at, usedBy: row.used_by,
    })),
    sales: sales.results.map((row) => ({
      id: row.id, slug: row.slug, saleName: parseSettings(row.settings).saleName, email: row.email,
      suspended: row.suspended === 1, createdAt: row.created_at, items: row.item_count, offers: row.offer_count,
    })),
  });
}

// Makes a random invite code like ABCD-EFGH-JKMN (60 bits).
function newInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => INVITE_ALPHABET[b & 31]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

// Creates a one-time invite code. The full code is only shown in this reply.
async function createInvite(request, env) {
  const body = await readJson(request);
  const code = newInviteCode();
  const invite = { id: crypto.randomUUID(), hint: code.slice(0, 4), note: cleanText(body.note, 100), createdAt: now() };
  await env.DB.prepare('INSERT INTO invites (id, code_hash, hint, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(invite.id, await sha256Hex(`invite:${normaliseCode(code)}`), invite.hint, invite.note, invite.createdAt).run();
  return json({ code, invite: { ...invite, usedAt: null, usedBy: null } }, 201);
}

// Cancels an invite that hasn't been used yet.
async function deleteInvite(env, id) {
  const result = await env.DB.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').bind(id).run();
  if (!result.meta.changes) throw new HttpError(404, "That invite doesn't exist or has been used.");
  return json({ ok: true });
}

// Pauses or un-pauses a sale. A paused sale and its photos disappear from the public site.
async function setSuspended(request, env, saleId) {
  const body = await readJson(request);
  const result = await env.DB.prepare('UPDATE sales SET suspended = ? WHERE id = ? AND seller_id IS NOT NULL')
    .bind(body.suspended === true ? 1 : 0, saleId).run();
  if (!result.meta.changes) throw new HttpError(404, 'That sale no longer exists.');
  return json({ ok: true, suspended: body.suspended === true });
}

// Deletes a seller, their sale, items, offers and photos for good.
async function deleteSale(env, saleId) {
  const sale = await env.DB.prepare('SELECT seller_id FROM sales WHERE id = ? AND seller_id IS NOT NULL')
    .bind(saleId).first();
  if (!sale) throw new HttpError(404, 'That sale no longer exists.');
  const { results } = await env.DB.prepare('SELECT id FROM photos WHERE sale_id = ?').bind(saleId).all();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM offers WHERE sale_id = ?').bind(saleId),
    env.DB.prepare('DELETE FROM items WHERE sale_id = ?').bind(saleId),
    env.DB.prepare('DELETE FROM photos WHERE sale_id = ?').bind(saleId),
    env.DB.prepare('DELETE FROM sales WHERE id = ?').bind(saleId),
    env.DB.prepare('UPDATE invites SET seller_id = NULL WHERE seller_id = ?').bind(sale.seller_id),
    env.DB.prepare('DELETE FROM sellers WHERE id = ?').bind(sale.seller_id),
  ]);
  await deletePhotoBytes(env, results.map((row) => row.id));
  return json({ ok: true });
}

// ---------- Seller admin ----------

// Returns everything the admin page needs in one request.
async function getAdminData(env, seller) {
  const [settings, items, offers] = await Promise.all([
    loadSettings(env, seller.saleId), loadItems(env, seller.saleId), loadOffers(env, seller.saleId),
  ]);
  return json({
    settings, items, offers, statuses: STATUSES,
    saleUrl: seller.slug ? `/${seller.slug}` : '/',
    email: seller.email,
  });
}

// Validates and saves the sale settings.
async function saveSettings(request, env, saleId) {
  const body = await readJson(request);
  const currency = cleanText(body.currency, 3).toUpperCase();
  const accent = cleanText(body.accent, 7);
  if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, 'Currency needs a 3-letter code, like NZD.');
  if (!/^#[0-9a-fA-F]{6}$/.test(accent)) throw new HttpError(400, 'Please pick a valid colour.');
  const settings = {
    saleName: cleanText(body.saleName, 80) || DEFAULT_SETTINGS.saleName,
    intro: cleanText(body.intro, 1000),
    location: cleanText(body.location, 120),
    currency,
    accent,
    closed: body.closed === true,
  };
  await env.DB.prepare('UPDATE sales SET settings = ? WHERE id = ?').bind(JSON.stringify(settings), saleId).run();
  return json(settings);
}

// Validates the editable product fields sent by the admin page.
function cleanItem(body) {
  const title = cleanText(body.title, 120);
  if (!title) throw new HttpError(400, 'Please give this item a name.');
  const price = cleanMoney(body.price, 'Price');
  if (price === null) throw new HttpError(400, 'Please add a price. Use 0 for free.');
  const status = STATUSES.includes(body.status) ? body.status : 'Available';
  const photos = Array.isArray(body.photos)
    ? [...new Set(body.photos.filter((id) => typeof id === 'string' && ID_PATTERN.test(id)))]
    : [];
  if (photos.length > MAX_PHOTOS_PER_ITEM) {
    throw new HttpError(400, `Each item can have up to ${MAX_PHOTOS_PER_ITEM} photos.`);
  }
  return {
    title,
    price,
    wasPrice: cleanMoney(body.wasPrice, 'Original price'),
    category: cleanText(body.category, 40) || 'Other',
    condition: cleanText(body.condition, 80),
    description: cleanText(body.description, 4000),
    status,
    photos,
  };
}

// Adds a new product to the top of the list.
async function createItem(request, env, saleId) {
  const fields = cleanItem(await readJson(request));
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM items WHERE sale_id = ?').bind(saleId).first('n');
  if (count >= MAX_ITEMS_PER_SALE) throw new HttpError(409, `A sale can have up to ${MAX_ITEMS_PER_SALE} items.`);
  const item = { id: crypto.randomUUID(), ...fields, photos: await ownedPhotoIds(env, saleId, fields.photos) };
  await env.DB.prepare(
    `INSERT INTO items (id, sale_id, title, price, was_price, category, condition, description, status, photos, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(item.id, saleId, item.title, item.price, item.wasPrice, item.category, item.condition,
    item.description, item.status, JSON.stringify(item.photos), now()).run();
  return json(item, 201);
}

// Saves changes to a product and removes any photos it no longer uses.
async function updateItem(request, env, saleId, id) {
  const changes = cleanItem(await readJson(request));
  const existing = await loadItem(env, saleId, id);
  if (!existing) throw new HttpError(404, 'That item no longer exists.');
  const item = { id, ...changes, photos: await ownedPhotoIds(env, saleId, changes.photos) };
  await env.DB.prepare(
    `UPDATE items SET title = ?, price = ?, was_price = ?, category = ?, condition = ?, description = ?,
       status = ?, photos = ? WHERE id = ? AND sale_id = ?`,
  ).bind(item.title, item.price, item.wasPrice, item.category, item.condition, item.description,
    item.status, JSON.stringify(item.photos), id, saleId).run();
  await removePhotos(env, saleId, existing.photos.filter((photo) => !item.photos.includes(photo)));
  return json(item);
}

// Removes a product along with its photos and offers.
async function deleteItem(env, saleId, id) {
  const item = await loadItem(env, saleId, id);
  if (!item) throw new HttpError(404, 'That item no longer exists.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM offers WHERE item_id = ? AND sale_id = ?').bind(id, saleId),
    env.DB.prepare('DELETE FROM items WHERE id = ? AND sale_id = ?').bind(id, saleId),
  ]);
  await removePhotos(env, saleId, item.photos);
  return json({ ok: true });
}
