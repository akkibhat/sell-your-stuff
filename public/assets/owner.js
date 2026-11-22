// The owner page (hosted mode): make invite codes and look after sellers' sales.
import { el, api, field, confirmButton } from './shared.js';

const state = { invites: [], sales: [], newCode: null };
const $ = (id) => document.getElementById(id);

// Tries to load the owner data, and shows the sign-in form if that's refused.
async function start() {
  $('loginForm').addEventListener('submit', handleLogin);
  $('signOut').addEventListener('click', () => run(async () => {
    await api('/api/owner/logout', { method: 'POST' });
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

// Signs in with the owner password, then loads the data.
async function handleLogin(event) {
  event.preventDefault();
  try {
    await api('/api/owner/login', { json: { password: $('password').value } });
    await load();
  } catch (error) {
    showLogin(error.message);
  }
}

// Fetches invites and sales, then draws the page.
async function load() {
  Object.assign(state, await api('/api/owner/data'));
  $('loginView').hidden = true;
  $('appView').hidden = false;
  render();
}

// Shows a short message at the top. It clears itself after a few seconds.
function flash(message, isError = false) {
  const box = $('flash');
  box.textContent = message;
  box.className = `flash${isError ? ' bad' : ''}`;
  box.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => { box.hidden = true; }, 5000);
}

// Runs an action and shows any failure, sending the owner to sign in if needed.
async function run(action) {
  try {
    return await action();
  } catch (error) {
    if (error.status === 401) showLogin('Please sign in again.');
    else flash(error.message, true);
    return undefined;
  }
}

// Formats an ISO date for the lists.
function when(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Draws the invite form, the new code (once), the invites list and the sales list.
function render() {
  const note = el('input', { maxLength: 100, placeholder: 'Who is it for? (optional)' });
  const inviteForm = el('form', {
    className: 'row',
    onsubmit: (event) => {
      event.preventDefault();
      run(async () => {
        const { code, invite } = await api('/api/owner/invites', { json: { note: note.value } });
        state.newCode = code;
        state.invites.unshift(invite);
        render();
      });
    },
  },
    el('div', { className: 'grow' }, field('New invite', note)),
    el('button', { className: 'btn primary', type: 'submit', text: 'Make an invite code' }));

  $('panel').replaceChildren(...[
    el('h2', { text: 'Invites' }),
    inviteForm,
    state.newCode && newCodeNotice(state.newCode),
    !state.invites.length && el('p', { className: 'muted', text: 'No invites yet.' }),
    ...state.invites.map(inviteRow),
    el('h2', { text: `Sales (${state.sales.length})` }),
    !state.sales.length && el('p', { className: 'muted', text: 'Nobody has signed up yet.' }),
    ...state.sales.map(saleRow),
  ].filter(Boolean));
}

// Makes the sign-up link for an invite. The code sits after the # so it never reaches the server's logs.
function inviteLink(code) {
  return `${window.location.origin}/signup#code=${encodeURIComponent(code)}`;
}

// Shares an invite link through the phone's share sheet, or copies it where sharing isn't available.
// If copying is blocked too, the link stays on screen so it can be copied by hand.
async function shareInvite(code, linkLine) {
  const url = inviteLink(code);
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Your Sell Your Stuff invite', text: "Here's your invite to set up a sale:", url });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    flash('Invite link copied. Paste it into a message.');
  } catch {
    linkLine.replaceChildren('Copy this link: ', el('b', { text: url }));
    linkLine.hidden = false;
  }
}

// Copies just the invite code, for people who'd rather type it in.
function copyCode(code) {
  navigator.clipboard.writeText(code).then(
    () => flash('Code copied.'),
    () => flash("Copying didn't work. Select the code and copy it.", true),
  );
}

// Shows a new invite code once, with buttons to share the link or copy the code.
function newCodeNotice(code) {
  const linkLine = el('p', { className: 'invite-link', hidden: true });
  return el('div', { className: 'notice invite-new' },
    el('p', {}, "Here's the code. Share or copy it now, it won't be shown again: ", el('b', { text: code })),
    el('div', { className: 'actions' },
      el('button', { className: 'btn primary small', type: 'button', text: 'Share invite', onclick: () => shareInvite(code, linkLine) }),
      el('button', { className: 'btn small', type: 'button', text: 'Copy code', onclick: () => copyCode(code) })),
    linkLine);
}

// Builds one invite row: who it's for and whether it's been used.
function inviteRow(invite) {
  const status = invite.usedAt
    ? `Used ${when(invite.usedAt)}${invite.usedBy ? ` by ${invite.usedBy}` : ' (seller since deleted)'}`
    : `Not used yet · made ${when(invite.createdAt)}`;
  return el('div', { className: 'row' },
    el('div', { className: 'grow' },
      el('h3', { text: `${invite.hint}-…${invite.note ? ` · ${invite.note}` : ''}` }),
      el('span', { className: 'muted', text: status })),
    !invite.usedAt && confirmButton('Cancel invite', () => run(async () => {
      await api(`/api/owner/invites/${encodeURIComponent(invite.id)}`, { method: 'DELETE' });
      state.invites = state.invites.filter((other) => other.id !== invite.id);
      render();
      flash('Invite cancelled.');
    })));
}

// Builds one sale row with its link, counts, pause and delete.
function saleRow(sale) {
  return el('div', { className: 'row' },
    el('div', { className: 'grow' },
      el('h3', {}, el('a', { href: `/${sale.slug}`, target: '_blank', rel: 'noopener', text: sale.saleName })),
      el('span', {
        className: 'muted',
        text: `/${sale.slug} · ${sale.email} · ${sale.items} items · ${sale.offers} offers · since ${when(sale.createdAt)}`,
      }),
      sale.suspended && el('div', { className: 'actions' }, el('span', { className: 'tag', text: 'Paused' }))),
    el('button', {
      className: 'btn small', type: 'button', text: sale.suspended ? 'Unpause' : 'Pause',
      onclick: () => run(async () => {
        await api(`/api/owner/sales/${encodeURIComponent(sale.id)}`, { method: 'PATCH', json: { suspended: !sale.suspended } });
        sale.suspended = !sale.suspended;
        render();
        flash(sale.suspended ? `${sale.saleName} is paused and hidden.` : `${sale.saleName} is live again.`);
      }),
    }),
    confirmButton('Delete for good', () => run(async () => {
      await api(`/api/owner/sales/${encodeURIComponent(sale.id)}`, { method: 'DELETE' });
      state.sales = state.sales.filter((other) => other.id !== sale.id);
      render();
      flash(`${sale.saleName} was deleted.`);
    })));
}

start();
