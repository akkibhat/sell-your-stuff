// The admin page: add, edit and remove items, manage offers and change settings.
import { el, money, api, applyAccent, field } from './shared.js';

const state = { settings: null, items: [], offers: [], statuses: [], tab: 'items' };
const freshPhotos = new Map(); // Photos uploaded this visit, shown from memory.
const MAX_PHOTO_SIDE = 1400;
const $ = (id) => document.getElementById(id);

// Tries to load the admin data, and shows the sign-in form if that's refused.
async function start() {
  $('loginForm').addEventListener('submit', handleLogin);
  $('signOut').addEventListener('click', () => run(async () => {
    await api('/api/admin/logout', { method: 'POST' });
    showLogin();
  }));
  try {
    await load();
  } catch (error) {
    showLogin(error.status === 401 ? '' : error.message);
  }
}

// Shows the sign-in form and hides the rest of the page.
function showLogin(message = '') {
  $('appView').hidden = true;
  $('loginView').hidden = false;
  $('loginError').textContent = message;
  $('password').value = '';
}

// Signs in with the typed password, then loads the admin data.
async function handleLogin(event) {
  event.preventDefault();
  try {
    await api('/api/admin/login', { json: { password: $('password').value } });
    await load();
  } catch (error) {
    showLogin(error.message);
  }
}

// Fetches everything from the server and draws the page.
async function load() {
  Object.assign(state, await api('/api/admin/data'));
  $('loginView').hidden = true;
  $('appView').hidden = false;
  render();
}

// Shows a short message under the tabs. It clears itself after a few seconds.
function flash(message, isError = false) {
  const box = $('flash');
  box.textContent = message;
  box.className = `flash${isError ? ' bad' : ''}`;
  box.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { box.hidden = true; }, 5000);
}

// Runs an action and shows any failure, sending the seller to sign in if needed.
async function run(action) {
  try {
    return await action();
  } catch (error) {
    if (error.status === 401) showLogin('Please sign in again.');
    else flash(error.message, true);
    return undefined;
  }
}

// Draws the tab pills and the panel for the current tab.
function render() {
  applyAccent(state.settings.accent);
  const tabs = [['items', `Items (${state.items.length})`], ['offers', `Offers (${state.offers.length})`], ['settings', 'Settings']];
  $('tabs').replaceChildren(...tabs.map(([id, label]) => el('button', {
    className: `pill${state.tab === id ? ' active' : ''}`,
    type: 'button',
    text: label,
    onclick: () => { state.tab = id; render(); },
  })));
  const panels = { items: itemsPanel, offers: offersPanel, settings: settingsPanel };
  $('panel').replaceChildren(...panels[state.tab]().filter(Boolean));
}

// Builds a button that asks for a second click before doing something permanent.
function confirmButton(label, action) {
  let armed = false;
  const button = el('button', { className: 'btn small danger', type: 'button', text: label });
  button.addEventListener('click', () => {
    if (armed) return action();
    armed = true;
    button.textContent = 'Click again to confirm';
    setTimeout(() => { armed = false; button.textContent = label; }, 4000);
    return undefined;
  });
  return button;
}

// Returns the image address for a photo, preferring one uploaded this visit.
function photoSrc(id) {
  return freshPhotos.get(id) || `/photos/${id}`;
}

// ---------- Items ----------

// Builds the Items tab: an add button and one row per item.
function itemsPanel() {
  return [
    el('div', { className: 'actions' },
      el('button', { className: 'btn primary', type: 'button', text: 'Add an item', onclick: () => openItemDialog(null) })),
    !state.items.length && el('p', { className: 'muted', text: 'Nothing listed yet. Add your first item to get going.' }),
    ...state.items.map(itemRow),
  ];
}

// Builds one item row with a quick status picker, edit and delete.
function itemRow(item) {
  const status = el('select', { 'aria-label': `Status of ${item.title}` },
    state.statuses.map((name) => el('option', { value: name, text: name, selected: name === item.status })));
  status.addEventListener('change', () => run(async () => {
    Object.assign(item, await api(`/api/admin/items/${item.id}`, { method: 'PUT', json: { ...item, status: status.value } }));
    flash(`${item.title} is now ${item.status}.`);
  }));
  return el('div', { className: 'row' },
    item.photos[0]
      ? el('img', { className: 'row-thumb', src: photoSrc(item.photos[0]), alt: '' })
      : el('div', { className: 'row-thumb' }),
    el('div', { className: 'grow' },
      el('h3', { text: item.title }),
      el('span', { className: 'muted', text: `${money(item.price, state.settings.currency)} · ${item.category}` })),
    status,
    el('button', { className: 'btn small', type: 'button', text: 'Edit', onclick: () => openItemDialog(item) }),
    confirmButton('Delete', () => run(async () => {
      await api(`/api/admin/items/${item.id}`, { method: 'DELETE' });
      state.items = state.items.filter((other) => other.id !== item.id);
      state.offers = state.offers.filter((offer) => offer.itemId !== item.id);
      render();
      flash(`${item.title} was deleted.`);
    })));
}

// Shrinks a photo in the browser before upload. Redrawing it also drops
// hidden details such as the GPS location phones store in photos.
async function resizePhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = el('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const toBlob = (type) => new Promise((resolve) => canvas.toBlob(resolve, type, 0.8));
  let blob = await toBlob('image/webp');
  // Some browsers can't write WebP and quietly hand back a PNG, so use JPEG there.
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg');
  return blob;
}

// Opens the add or edit form for an item, including its photos.
function openItemDialog(item) {
  const dialog = $('dialog');
  const photos = item ? [...item.photos] : [];
  const uploaded = []; // Photos added in this form, removed again if not saved.
  let savedPhotos = null;

  const input = (props) => el('input', props);
  const title = input({ required: true, maxLength: 120, value: item?.title ?? '' });
  const price = input({ type: 'number', min: '0', step: '0.01', required: true, value: item?.price ?? '' });
  const wasPrice = input({ type: 'number', min: '0', step: '0.01', value: item?.wasPrice ?? '' });
  const category = input({ maxLength: 40, list: 'categoryList', value: item?.category ?? '' });
  const condition = input({ maxLength: 80, value: item?.condition ?? '', placeholder: 'Like new, a few marks...' });
  const description = el('textarea', { rows: 5, maxLength: 4000, value: item?.description ?? '' });
  const status = el('select', {},
    state.statuses.map((name) => el('option', { value: name, text: name, selected: name === (item?.status ?? 'Available') })));
  const categories = [...new Set(state.items.map((other) => other.category))].sort();
  const photoList = el('div', { className: 'photo-list' });
  const error = el('p', { className: 'error', role: 'alert' });
  const save = el('button', { className: 'btn primary', type: 'submit', text: item ? 'Save changes' : 'Add item' });

  // Redraws the photo thumbnails with their Make main and Remove buttons.
  const drawPhotos = () => photoList.replaceChildren(...photos.map((id, index) =>
    el('div', { className: 'photo-chip' },
      el('img', { src: photoSrc(id), alt: `Photo ${index + 1}` }),
      index > 0 && el('button', {
        className: 'btn small', type: 'button', text: 'Make main',
        onclick: () => { photos.splice(index, 1); photos.unshift(id); drawPhotos(); },
      }),
      el('button', {
        className: 'btn small', type: 'button', text: 'Remove',
        onclick: () => { photos.splice(index, 1); drawPhotos(); },
      }))));
  drawPhotos();

  const picker = input({ type: 'file', accept: 'image/*', multiple: true });
  picker.addEventListener('change', async () => {
    save.disabled = true;
    error.textContent = '';
    for (const file of picker.files) {
      if (photos.length >= 8) { error.textContent = 'Each item can have up to 8 photos.'; break; }
      try {
        const blob = await resizePhoto(file);
        const { id } = await api('/api/admin/photos', { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } });
        freshPhotos.set(id, URL.createObjectURL(blob));
        uploaded.push(id);
        photos.push(id);
        drawPhotos();
      } catch (problem) {
        error.textContent = `${file.name} could not be added. ${problem.message || ''}`;
      }
    }
    picker.value = '';
    save.disabled = false;
  });

  const form = el('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      save.disabled = true;
      error.textContent = '';
      const payload = {
        title: title.value, price: price.value, wasPrice: wasPrice.value, category: category.value,
        condition: condition.value, description: description.value, status: status.value, photos,
      };
      try {
        if (item) {
          Object.assign(item, await api(`/api/admin/items/${item.id}`, { method: 'PUT', json: payload }));
          savedPhotos = item.photos;
        } else {
          const created = await api('/api/admin/items', { json: payload });
          state.items.unshift(created);
          savedPhotos = created.photos;
        }
        dialog.close();
        render();
        flash(item ? 'Changes saved.' : 'Item added.');
      } catch (problem) {
        if (problem.status === 401) { dialog.close(); showLogin('Please sign in again.'); return; }
        error.textContent = problem.message;
        save.disabled = false;
      }
    },
  },
    field('Name', title),
    el('div', { className: 'two' },
      field(`Price in ${state.settings.currency} (0 for free)`, price),
      field('Original price, if you dropped it (optional)', wasPrice)),
    el('div', { className: 'two' }, field('Category', category), field('Status', status)),
    el('datalist', { id: 'categoryList' }, categories.map((name) => el('option', { value: name }))),
    field('Condition (optional)', condition),
    field('Description (optional)', description),
    field('Photos (up to 8, the first one is the main photo)', picker),
    photoList,
    el('div', { className: 'actions' },
      save,
      el('button', { className: 'btn', type: 'button', text: 'Cancel', onclick: () => dialog.close() })),
    error);

  // When the form closes, delete any new uploads that didn't end up on the item.
  dialog.onclose = () => {
    const kept = savedPhotos || [];
    uploaded.filter((id) => !kept.includes(id)).forEach((id) => {
      api(`/api/admin/photos/${id}`, { method: 'DELETE' }).catch(() => {});
    });
  };
  dialog.replaceChildren(el('div', { className: 'dialog-body' },
    el('h2', { text: item ? 'Edit item' : 'Add an item' }), form));
  dialog.showModal();
}

// ---------- Offers ----------

// Works out what a winning offer is worth: its amount, or the item's price.
function offerValue(offer) {
  if (offer.amount !== null) return offer.amount;
  return state.items.find((item) => item.id === offer.itemId)?.price ?? 0;
}

// Builds the Offers tab: totals, an add button and offers grouped by item.
function offersPanel() {
  const { currency } = state.settings;
  const winners = state.offers.filter((offer) => offer.winner);
  const sum = (offers) => offers.reduce((total, offer) => total + offerValue(offer), 0);
  const total = (label, amount) => el('div', {}, el('b', { text: amount ? money(amount, currency) : `0 ${currency}` }), label);

  const groups = state.items
    .map((item) => ({ item, offers: state.offers.filter((offer) => offer.itemId === item.id) }))
    .filter((group) => group.offers.length);

  return [
    el('div', { className: 'row totals' },
      total('Agreed with buyers', sum(winners)),
      total('Money received', sum(winners.filter((offer) => offer.paid))),
      el('div', { className: 'grow' }),
      el('button', {
        className: 'btn primary', type: 'button', text: 'Add an offer', disabled: !state.items.length,
        onclick: openOfferDialog,
      })),
    !groups.length && el('p', { className: 'muted', text: 'No offers yet. Offers from the sale page land here. You can also add ones you get by text or in person.' }),
    ...groups.map(({ item, offers }) => el('section', { className: 'group' },
      el('h2', { text: `${item.title} · ${money(item.price, currency)} · ${item.status}` }),
      offers.map(offerRow))),
  ];
}

// Sends a change to one offer and redraws with the server's reply.
function patchOffer(offer, changes, message) {
  return run(async () => {
    Object.assign(offer, await api(`/api/admin/offers/${encodeURIComponent(offer.key)}`, { method: 'PATCH', json: changes }));
    if (changes.winner) {
      // Mirror what the server did: one winner per item, and Available becomes Pending.
      state.offers.forEach((other) => {
        if (other.itemId === offer.itemId && other.key !== offer.key) other.winner = false;
      });
      const item = state.items.find((candidate) => candidate.id === offer.itemId);
      if (item?.status === 'Available') item.status = 'Pending';
    }
    render();
    if (message) flash(message);
  });
}

// Builds one offer row with its amount box and action buttons.
function offerRow(offer) {
  const amount = el('input', {
    className: 'amount', type: 'number', min: '0', step: '0.01',
    value: offer.amount ?? '', placeholder: 'Amount', 'aria-label': `Offer amount from ${offer.name}`,
  });
  amount.addEventListener('change', () => patchOffer(offer, { amount: amount.value }, 'Amount updated.'));
  const toggle = (label, changes) => el('button', {
    className: 'btn small', type: 'button', text: label, onclick: () => patchOffer(offer, changes),
  });
  const when = new Date(offer.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return el('div', { className: 'row' },
    el('div', { className: 'grow' },
      el('h3', { text: offer.name }),
      el('span', { className: 'muted', text: [offer.email, when].filter(Boolean).join(' · ') }),
      el('div', { className: 'actions' },
        el('span', { className: 'tag', text: offer.source }),
        offer.winner && el('span', { className: 'tag win', text: 'Winner' }),
        offer.paid && el('span', { className: 'tag', text: 'Paid' }),
        offer.pickedUp && el('span', { className: 'tag', text: 'Picked up' })),
      offer.message && el('p', { className: 'message', text: offer.message })),
    amount,
    offer.winner
      ? [
        toggle(offer.paid ? 'Mark unpaid' : 'Mark paid', { paid: !offer.paid }),
        toggle(offer.pickedUp ? 'Not picked up' : 'Mark picked up', { pickedUp: !offer.pickedUp }),
        toggle('Undo winner', { winner: false, paid: false, pickedUp: false }),
      ]
      : toggle('Pick as winner', { winner: true }),
    confirmButton('Delete', () => run(async () => {
      await api(`/api/admin/offers/${encodeURIComponent(offer.key)}`, { method: 'DELETE' });
      state.offers = state.offers.filter((other) => other.key !== offer.key);
      render();
    })));
}

// Opens the form for adding an offer the seller got outside the site.
function openOfferDialog() {
  const dialog = $('dialog');
  dialog.onclose = null;
  const item = el('select', {}, state.items.map((entry) => el('option', { value: entry.id, text: entry.title })));
  const name = el('input', { required: true, maxLength: 100 });
  const email = el('input', { type: 'email', maxLength: 200 });
  const amount = el('input', { type: 'number', min: '0', step: '0.01' });
  const source = el('input', { maxLength: 40, placeholder: 'Text, Facebook, in person...' });
  const message = el('textarea', { rows: 3, maxLength: 2000 });
  const error = el('p', { className: 'error', role: 'alert' });
  const save = el('button', { className: 'btn primary', type: 'submit', text: 'Add offer' });

  const form = el('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      save.disabled = true;
      try {
        state.offers.unshift(await api('/api/admin/offers', {
          json: {
            itemId: item.value, name: name.value, email: email.value,
            amount: amount.value, source: source.value, message: message.value,
          },
        }));
        dialog.close();
        render();
        flash('Offer added.');
      } catch (problem) {
        error.textContent = problem.message;
        save.disabled = false;
      }
    },
  },
    field('Item', item),
    el('div', { className: 'two' }, field('Buyer name', name), field('Buyer email (optional)', email)),
    el('div', { className: 'two' },
      field(`Offer in ${state.settings.currency} (optional)`, amount),
      field('Where it came from (optional)', source)),
    field('Notes (optional)', message),
    el('div', { className: 'actions' },
      save,
      el('button', { className: 'btn', type: 'button', text: 'Cancel', onclick: () => dialog.close() })),
    error);
  dialog.replaceChildren(el('div', { className: 'dialog-body' }, el('h2', { text: 'Add an offer' }), form));
  dialog.showModal();
}

// ---------- Settings ----------

// Builds the Settings tab form.
function settingsPanel() {
  const { settings } = state;
  const saleName = el('input', { required: true, maxLength: 80, value: settings.saleName });
  const intro = el('textarea', { rows: 4, maxLength: 1000, value: settings.intro });
  const location = el('input', { maxLength: 120, value: settings.location, placeholder: 'Suburb or town. Skip your street address.' });
  const currency = el('input', { required: true, maxLength: 3, value: settings.currency });
  const accent = el('input', { type: 'color', value: settings.accent });
  const closed = el('input', { type: 'checkbox', checked: settings.closed });

  return [el('form', {
    className: 'row',
    onsubmit: (event) => {
      event.preventDefault();
      run(async () => {
        state.settings = await api('/api/admin/settings', {
          method: 'PUT',
          json: {
            saleName: saleName.value, intro: intro.value, location: location.value,
            currency: currency.value, accent: accent.value, closed: closed.checked,
          },
        });
        render();
        flash('Settings saved.');
      });
    },
  },
    el('div', { className: 'grow group' },
      field('Sale name', saleName),
      field('Intro shown at the top of your sale page (optional)', intro),
      field('Pickup location (optional)', location),
      el('div', { className: 'two' },
        field('Currency code, like NZD, AUD or USD', currency),
        field('Accent colour', accent)),
      el('label', { className: 'field check' }, closed, 'Close the sale and stop taking offers'),
      el('div', { className: 'actions' },
        el('button', { className: 'btn primary', type: 'submit', text: 'Save settings' }))))];
}

start();
