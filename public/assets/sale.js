// The public sale page: shows the items and takes offers from buyers.
import { el, money, api, applyAccent, field } from './shared.js';

const state = { settings: null, items: [], view: 'open', category: 'All' };
const $ = (id) => document.getElementById(id);

// Loads the sale and draws the page.
async function start() {
  try {
    const sale = await api('/api/sale');
    state.settings = sale.settings;
    state.items = sale.items;
  } catch (error) {
    $('empty').textContent = error.message;
    $('empty').hidden = false;
    return;
  }
  const { settings } = state;
  applyAccent(settings.accent);
  document.title = settings.saleName;
  $('saleName').textContent = settings.saleName;
  $('intro').textContent = settings.intro;
  $('location').textContent = settings.location ? `Pickup: ${settings.location}` : '';
  $('closedNote').hidden = !settings.closed;
  render();
}

// Says whether an item belongs in the current "For sale" or "Sold" view.
function inView(item) {
  return state.view === 'sold' ? item.status === 'Sold' : item.status !== 'Sold';
}

// Draws the filter pills and the grid of item cards.
function render() {
  const viewItems = state.items.filter(inView);
  const categories = [...new Set(viewItems.map((item) => item.category))].sort();
  if (!categories.includes(state.category)) state.category = 'All';
  const shown = viewItems.filter((item) => state.category === 'All' || item.category === state.category);
  const soldCount = state.items.filter((item) => item.status === 'Sold').length;

  const pill = (label, active, onclick) =>
    el('button', { className: `pill${active ? ' active' : ''}`, type: 'button', text: label, onclick });
  const setView = (view) => () => { state.view = view; render(); };
  const setCategory = (category) => () => { state.category = category; render(); };

  $('filters').replaceChildren(
    pill(`For sale (${state.items.length - soldCount})`, state.view === 'open', setView('open')),
    soldCount > 0 && pill(`Sold (${soldCount})`, state.view === 'sold', setView('sold')),
    ...(categories.length > 1
      ? ['All', ...categories].map((name) => pill(name, state.category === name, setCategory(name)))
      : []),
  );
  $('grid').replaceChildren(...shown.map(card));
  $('empty').textContent = state.items.length ? 'Nothing here right now.' : 'Nothing listed yet. Check back soon.';
  $('empty').hidden = shown.length > 0;
}

// Builds the price line, with the old price struck through after a price drop.
function priceLine(item) {
  const { currency } = state.settings;
  return el('span', { className: 'price', text: money(item.price, currency) },
    item.wasPrice > item.price && el('span', { className: 'was', text: money(item.wasPrice, currency) }));
}

// Builds the photo area for an item, with a status badge when it isn't available.
function photoBox(item, photoId, extraClass = '') {
  return el('div', { className: `photo-box ${extraClass}` },
    photoId
      ? el('img', { src: `/photos/${photoId}`, alt: item.title, loading: 'lazy' })
      : el('span', { text: 'No photo' }),
    item.status === 'Pending' && el('span', { className: 'badge', text: 'Pending' }),
    item.status === 'Sold' && el('span', { className: 'badge sold', text: 'Sold' }));
}

// Builds one item card that opens the detail dialog when clicked.
function card(item) {
  return el('button', {
    className: `card${item.status === 'Sold' ? ' sold' : ''}`,
    type: 'button',
    onclick: () => openItem(item),
  },
    photoBox(item, item.photos[0]),
    el('div', { className: 'card-body' },
      el('h3', { text: item.title }),
      priceLine(item),
      item.condition && el('span', { className: 'muted', text: item.condition })));
}

// Opens the detail dialog with photos, description and the offer form.
function openItem(item) {
  const dialog = $('itemDialog');
  const photoHolder = el('div');
  const thumbs = el('div', { className: 'thumbs' });

  // Shows one photo large and highlights its thumbnail.
  const showPhoto = (index) => {
    photoHolder.replaceChildren(photoBox(item, item.photos[index], 'contain'));
    [...thumbs.children].forEach((button, i) => button.classList.toggle('active', i === index));
  };
  if (item.photos.length > 1) {
    thumbs.append(...item.photos.map((id, index) =>
      el('button', { type: 'button', 'aria-label': `Photo ${index + 1}`, onclick: () => showPhoto(index) },
        el('img', { src: `/photos/${id}`, alt: '' }))));
  }
  showPhoto(0);

  dialog.replaceChildren(el('div', { className: 'dialog-body' },
    el('div', { className: 'dialog-head' },
      el('h2', { text: item.title }),
      el('button', { className: 'btn small', type: 'button', text: 'Close', onclick: () => dialog.close() })),
    photoHolder,
    thumbs,
    priceLine(item),
    item.condition && el('p', { className: 'muted', text: `Condition: ${item.condition}` }),
    item.description && el('p', { className: 'description', text: item.description }),
    offerSection(item)));
  dialog.showModal();
}

// Builds the offer form, or a short note when offers aren't being taken.
function offerSection(item) {
  if (state.settings.closed) return el('p', { className: 'notice', text: 'This sale has closed.' });
  if (item.status === 'Sold') return el('p', { className: 'notice', text: 'This one has sold.' });

  const name = el('input', { name: 'name', required: true, maxLength: 100, autocomplete: 'name' });
  const email = el('input', { name: 'email', type: 'email', required: true, maxLength: 200, autocomplete: 'email' });
  const amount = el('input', { name: 'amount', type: 'number', min: '0', step: '0.01', inputMode: 'decimal' });
  const message = el('textarea', { name: 'message', rows: 3, maxLength: 2000 });
  const website = el('input', { name: 'website', tabIndex: -1, autocomplete: 'off' });
  const error = el('p', { className: 'error', role: 'alert' });
  const submit = el('button', { className: 'btn primary', type: 'submit', text: 'Send offer' });

  const form = el('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = '';
      try {
        await api('/api/offers', {
          json: {
            itemId: item.id, name: name.value, email: email.value,
            amount: amount.value, message: message.value, website: website.value,
          },
        });
        form.replaceWith(el('p', { className: 'notice', text: "Thanks, your offer's been sent. The seller will be in touch by email." }));
      } catch (problem) {
        error.textContent = problem.message;
        submit.disabled = false;
      }
    },
  },
    el('h3', { text: item.status === 'Pending' ? 'Make a backup offer' : 'Make an offer' }),
    item.status === 'Pending' && el('p', { className: 'muted', text: 'Someone is already lined up for this, but you can still put an offer in.' }),
    el('div', { className: 'two' }, field('Your name', name), field('Your email', email)),
    field(`Your offer in ${state.settings.currency} (optional)`, amount),
    field('Message (optional)', message),
    el('label', { className: 'trap', 'aria-hidden': 'true' }, 'Leave this empty', website),
    el('div', { className: 'actions' }, submit),
    error);
  return form;
}

start();
