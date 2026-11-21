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

// Wires up the form: link suggestions while typing, and sending the sign-up.
function start() {
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
