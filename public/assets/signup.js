// The hosted sign-up page: turns an invite code into a seller account and a sale.
import { api } from './shared.js';

const $ = (id) => document.getElementById(id);
let slugEdited = false; // Stop suggesting a link once the seller types their own.

// Turns a sale name into a suggested link, like "Sam's Sale!" to "sams-sale".
function suggestSlug(name) {
  return name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Shows the full address the sale will live at.
function showPreview() {
  const slug = $('slug').value;
  $('slugPreview').textContent = slug ? `Your sale will be at ${window.location.host}/${slug}` : '';
}

// Fills in the invite code from a shared link (/signup#code=...), then clears it from the address bar.
function prefillCode() {
  const code = new URLSearchParams(window.location.hash.slice(1)).get('code');
  if (!code) return;
  $('code').value = code.slice(0, 40);
  window.history.replaceState(null, '', window.location.pathname);
  $('email').focus();
}

// Wires up the form: link suggestions while typing, and sending the sign-up.
function start() {
  prefillCode();
  $('saleName').addEventListener('input', () => {
    if (!slugEdited) $('slug').value = suggestSlug($('saleName').value);
    showPreview();
  });
  $('slug').addEventListener('input', () => {
    slugEdited = true;
    $('slug').value = $('slug').value.toLowerCase();
    showPreview();
  });
  $('signupForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter;
    if (button) button.disabled = true;
    $('signupError').textContent = '';
    try {
      await api('/api/signup', {
        json: {
          code: $('code').value, email: $('email').value, password: $('password').value,
          saleName: $('saleName').value, slug: $('slug').value,
        },
      });
      window.location.href = '/admin';
    } catch (error) {
      $('signupError').textContent = error.message;
      if (button) button.disabled = false;
    }
  });
}

start();
