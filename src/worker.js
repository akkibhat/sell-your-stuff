// Sell Your Stuff: the Cloudflare Worker behind the sale site.
//
// Everything lives in one KV namespace (SALE_KV):
//   settings           the sale name, intro, location, currency and colour
//   items              every product, as one JSON list
//   photo:<id>         one resized product photo
//   offer:<date>:<id>  one offer from a buyer
//   rate:<bucket>:<ip> short-lived counters that slow down spam and guessing

const STATUSES = ['Draft', 'Available', 'Pending', 'Sold'];
const DEFAULT_SETTINGS = {
  saleName: 'My Sale',
  intro: '',
  location: '',
  currency: 'NZD',
  accent: '#2f6f5e',
  closed: false,
};
const MAX_PHOTOS_PER_ITEM = 8;
const MAX_PHOTO_BYTES = 1_500_000;
const MAX_JSON_BYTES = 20_000;
const SESSION_COOKIE = 'sale_session';
const SESSION_SECONDS = 60 * 60 * 12;
const ID_PATTERN = /^[a-f0-9-]{36}$/;
const OFFER_KEY_PATTERN = /^offer:[0-9TZ:.-]+:[a-f0-9]{8}$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

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

// Sends a request to the public routes, admin routes or static files.
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (pathname.startsWith('/photos/') && method === 'GET') return getPhoto(request, env, ctx, pathname);
  if (pathname === '/api/sale' && method === 'GET') return getSale(env);
  if (pathname === '/api/offers' && method === 'POST') return submitOffer(request, env, ctx);
  if (pathname === '/api/admin/login' && method === 'POST') return login(request, env);
  if (pathname.startsWith('/api/admin/')) {
    await requireAdmin(request, env);
    return adminRoute(request, env, pathname, method);
  }
  if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
  return env.ASSETS.fetch(request);
}

// Handles the signed-in routes. requireAdmin has already checked the session.
async function adminRoute(request, env, pathname, method) {
  const parts = pathname.split('/').slice(3).map(decodeURIComponent);
  const [area, id] = parts;

  if (area === 'logout' && method === 'POST') return logout();
  if (area === 'data' && method === 'GET') return getAdminData(env);
  if (area === 'settings' && method === 'PUT') return saveSettings(request, env);
  if (area === 'items' && !id && method === 'POST') return createItem(request, env);
  if (area === 'items' && id && method === 'PUT') return updateItem(request, env, id);
  if (area === 'items' && id && method === 'DELETE') return deleteItem(env, id);
  if (area === 'photos' && !id && method === 'POST') return uploadPhoto(request, env);
  if (area === 'photos' && id && method === 'DELETE') return deletePhoto(env, id);
  if (area === 'offers' && !id && method === 'POST') return addManualOffer(request, env);
  if (area === 'offers' && id && method === 'PATCH') return updateOffer(request, env, id);
  if (area === 'offers' && id && method === 'DELETE') return deleteOffer(env, id);
  throw new HttpError(404, 'Not found');
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

// Loads the sale settings, filling in defaults for anything not set yet.
async function loadSettings(env) {
  const saved = await env.SALE_KV.get('settings', 'json');
  return { ...DEFAULT_SETTINGS, ...(saved || {}) };
}

// Loads the full product list.
async function loadItems(env) {
  return (await env.SALE_KV.get('items', 'json')) || [];
}

// Saves the full product list.
async function saveItems(env, items) {
  await env.SALE_KV.put('items', JSON.stringify(items));
}

// Loads every offer, each tagged with the KV key it's stored under.
async function loadOffers(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.SALE_KV.list({ prefix: 'offer:', cursor });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const records = await Promise.all(keys.map((key) => env.SALE_KV.get(key, 'json')));
  return keys
    .map((key, index) => (records[index] ? { key, ...records[index] } : null))
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date));
}

// Saves one offer record without its in-memory key field.
async function saveOffer(env, offer) {
  const { key, ...record } = offer;
  await env.SALE_KV.put(key, JSON.stringify(record));
}

// Creates the storage key for a new offer.
function newOfferKey() {
  return `offer:${new Date().toISOString()}:${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
}

// Returns the public sale page data, leaving out draft products.
async function getSale(env) {
  const [settings, items] = await Promise.all([loadSettings(env), loadItems(env)]);
  return json({ settings, items: items.filter((item) => item.status !== 'Draft') });
}

// Serves a product photo, using Cloudflare's cache to save on KV reads.
async function getPhoto(request, env, ctx, pathname) {
  const id = pathname.slice('/photos/'.length);
  if (!ID_PATTERN.test(id)) throw new HttpError(404, 'Not found');
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const { value, metadata } = await env.SALE_KV.getWithMetadata(`photo:${id}`, 'arrayBuffer');
  if (!value) throw new HttpError(404, 'Not found');
  const response = new Response(value, {
    headers: {
      'Content-Type': metadata?.type || 'image/webp',
      // One day, so a deleted photo drops out of caches soon after.
      'Cache-Control': 'public, max-age=86400',
    },
  });
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

// Stores a buyer's offer and emails the seller when email is set up.
async function submitOffer(request, env, ctx) {
  const body = await readJson(request);
  // Bots fill in this hidden field, so pretend it worked and store nothing.
  if (body.website) return json({ ok: true });

  if (await isRateLimited(request, env, 'offer', 5)) {
    throw new HttpError(429, 'Too many offers from here. Please try again later.');
  }

  const [settings, items] = await Promise.all([loadSettings(env), loadItems(env)]);
  if (settings.closed) throw new HttpError(409, 'This sale has closed.');
  const item = items.find((candidate) => candidate.id === body.itemId);
  if (!item || item.status === 'Draft') throw new HttpError(404, 'That item is no longer listed.');
  if (item.status === 'Sold') throw new HttpError(409, 'That item has already sold.');

  const offer = buildOffer(body, item, 'Website');
  if (!EMAIL_PATTERN.test(offer.email)) throw new HttpError(400, 'Please enter a valid email address.');
  await saveOffer(env, offer);
  await countAttempt(request, env, 'offer', 3600);
  ctx.waitUntil(sendOfferEmail(env, offer, settings).catch((error) => console.error(error)));
  return json({ ok: true });
}

// Validates shared offer fields and builds the record to store.
function buildOffer(body, item, source) {
  const name = cleanText(body.name, 100);
  if (!name) throw new HttpError(400, 'Please add a name.');
  return {
    key: newOfferKey(),
    itemId: item.id,
    itemTitle: item.title,
    name,
    email: cleanText(body.email, 200),
    amount: cleanMoney(body.amount, 'The offer'),
    message: cleanText(body.message, 2000),
    source,
    date: new Date().toISOString(),
    winner: false,
    paid: false,
    pickedUp: false,
  };
}

// Sends the optional new-offer email through Resend.
async function sendOfferEmail(env, offer, settings) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL || !env.SENDER_EMAIL) return;
  const amount = offer.amount === null ? 'No amount given' : `${offer.amount} ${settings.currency}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.SENDER_EMAIL,
      to: env.NOTIFY_EMAIL,
      reply_to: offer.email,
      subject: `New offer: ${offer.itemTitle}`,
      text: `Item: ${offer.itemTitle}\nName: ${offer.name}\nEmail: ${offer.email}\nOffer: ${amount}\n\n${offer.message}`,
    }),
  });
  if (!response.ok) console.error('Offer email failed', response.status);
}

// Builds the KV key that counts attempts from one visitor, without storing their IP.
async function rateKey(request, bucket) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${bucket}:${ip}`));
  const hash = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `rate:${bucket}:${hash}`;
}

// Checks whether a visitor has used up their attempts.
async function isRateLimited(request, env, bucket, limit) {
  const count = Number(await env.SALE_KV.get(await rateKey(request, bucket))) || 0;
  return count >= limit;
}

// Records one attempt, which expires after the given number of seconds.
async function countAttempt(request, env, bucket, seconds) {
  const key = await rateKey(request, bucket);
  const count = Number(await env.SALE_KV.get(key)) || 0;
  await env.SALE_KV.put(key, String(count + 1), { expirationTtl: seconds });
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

// Creates the signing key for sessions. Changing the password signs everyone out.
function sessionKey(env, usages) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`session:${env.ADMIN_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

// Checks the password and signs the seller in with a protected cookie.
async function login(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, 'Set ADMIN_PASSWORD in Cloudflare first.');
  if (await isRateLimited(request, env, 'login', 10)) {
    throw new HttpError(429, 'Too many tries. Please wait 15 minutes.');
  }
  const body = await readJson(request);
  if (!(await safeEqual(String(body.password || ''), env.ADMIN_PASSWORD))) {
    await countAttempt(request, env, 'login', 900);
    throw new HttpError(401, 'That password is not right.');
  }
  const expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const key = await sessionKey(env, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(expires));
  const token = `${expires}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// Signs the seller out by clearing the cookie.
function logout() {
  const cookie = `${SESSION_COOKIE}=; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
  return json({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// Stops the request unless it carries a valid, unexpired session cookie.
async function requireAdmin(request, env) {
  const denied = new HttpError(401, 'Please sign in.');
  if (!env.ADMIN_PASSWORD) throw denied;
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.split(/;\s*/).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (!match) throw denied;
  const [expires, signature] = decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)).split('.');
  if (!expires || !signature || Number(expires) < Date.now() / 1000) throw denied;
  try {
    const bytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
    const key = await sessionKey(env, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(expires));
    if (!valid) throw denied;
  } catch {
    throw denied;
  }
}

// Returns everything the admin page needs in one request.
async function getAdminData(env) {
  const [settings, items, offers] = await Promise.all([loadSettings(env), loadItems(env), loadOffers(env)]);
  return json({ settings, items, offers, statuses: STATUSES });
}

// Validates and saves the sale settings.
async function saveSettings(request, env) {
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
  await env.SALE_KV.put('settings', JSON.stringify(settings));
  return json(settings);
}

// Validates the editable product fields sent by the admin page.
function cleanItem(body) {
  const title = cleanText(body.title, 120);
  if (!title) throw new HttpError(400, 'Please give this item a name.');
  const price = cleanMoney(body.price, 'Price');
  if (price === null) throw new HttpError(400, 'Please add a price. Use 0 for free.');
  const status = STATUSES.includes(body.status) ? body.status : 'Available';
  const photos = Array.isArray(body.photos) ? body.photos.filter((id) => ID_PATTERN.test(id)) : [];
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
async function createItem(request, env) {
  const item = { id: crypto.randomUUID(), ...cleanItem(await readJson(request)) };
  const items = await loadItems(env);
  await saveItems(env, [item, ...items]);
  return json(item, 201);
}

// Saves changes to a product and removes any photos it no longer uses.
async function updateItem(request, env, id) {
  const changes = cleanItem(await readJson(request));
  const items = await loadItems(env);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw new HttpError(404, 'That item no longer exists.');
  const removedPhotos = items[index].photos.filter((photo) => !changes.photos.includes(photo));
  items[index] = { id, ...changes };
  await saveItems(env, items);
  await Promise.all(removedPhotos.map((photo) => env.SALE_KV.delete(`photo:${photo}`)));
  return json(items[index]);
}

// Removes a product along with its photos and offers.
async function deleteItem(env, id) {
  const [items, offers] = await Promise.all([loadItems(env), loadOffers(env)]);
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new HttpError(404, 'That item no longer exists.');
  await saveItems(env, items.filter((candidate) => candidate.id !== id));
  await Promise.all([
    ...item.photos.map((photo) => env.SALE_KV.delete(`photo:${photo}`)),
    ...offers.filter((offer) => offer.itemId === id).map((offer) => env.SALE_KV.delete(offer.key)),
  ]);
  return json({ ok: true });
}

// Checks a file's first bytes really are a WebP or JPEG image.
function photoTypeOf(bytes) {
  const header = String.fromCharCode(...bytes.slice(0, 12));
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

// Stores one photo that the admin page has already resized.
async function uploadPhoto(request, env) {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_PHOTO_BYTES) throw new HttpError(413, 'That photo is too large.');
  const type = photoTypeOf(new Uint8Array(buffer));
  if (!type) throw new HttpError(415, 'Photos need to be WebP or JPEG.');
  const id = crypto.randomUUID();
  await env.SALE_KV.put(`photo:${id}`, buffer, { metadata: { type } });
  return json({ id }, 201);
}

// Deletes a photo that was uploaded but never saved onto a product.
async function deletePhoto(env, id) {
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'That photo is not valid.');
  const items = await loadItems(env);
  if (items.some((item) => item.photos.includes(id))) throw new HttpError(409, 'That photo is in use.');
  await env.SALE_KV.delete(`photo:${id}`);
  return json({ ok: true });
}

// Records an offer the seller heard about somewhere else, like a text message.
async function addManualOffer(request, env) {
  const body = await readJson(request);
  const items = await loadItems(env);
  const item = items.find((candidate) => candidate.id === body.itemId);
  if (!item) throw new HttpError(404, 'That item no longer exists.');
  const offer = buildOffer(body, item, cleanText(body.source, 40) || 'Added by seller');
  await saveOffer(env, offer);
  return json(offer, 201);
}

// Updates an offer's amount, winner, paid or picked-up details.
async function updateOffer(request, env, key) {
  if (!OFFER_KEY_PATTERN.test(key)) throw new HttpError(400, 'That offer is not valid.');
  const body = await readJson(request);
  const record = await env.SALE_KV.get(key, 'json');
  if (!record) throw new HttpError(404, 'That offer no longer exists.');
  const offer = { key, ...record };
  if ('amount' in body) offer.amount = cleanMoney(body.amount, 'The offer');
  if ('paid' in body) offer.paid = body.paid === true;
  if ('pickedUp' in body) offer.pickedUp = body.pickedUp === true;
  if ('winner' in body) {
    offer.winner = body.winner === true;
    if (offer.winner) await chooseWinner(env, offer);
  }
  await saveOffer(env, offer);
  return json(offer);
}

// Clears any previous winner on the item and marks an available item as pending.
async function chooseWinner(env, winner) {
  const [offers, items] = await Promise.all([loadOffers(env), loadItems(env)]);
  const previous = offers.filter(
    (offer) => offer.itemId === winner.itemId && offer.key !== winner.key && offer.winner,
  );
  await Promise.all(previous.map((offer) => saveOffer(env, { ...offer, winner: false })));
  const item = items.find((candidate) => candidate.id === winner.itemId);
  if (item?.status === 'Available') {
    item.status = 'Pending';
    await saveItems(env, items);
  }
}

// Deletes one offer, which is handy for spam.
async function deleteOffer(env, key) {
  if (!OFFER_KEY_PATTERN.test(key)) throw new HttpError(400, 'That offer is not valid.');
  await env.SALE_KV.delete(key);
  return json({ ok: true });
}
