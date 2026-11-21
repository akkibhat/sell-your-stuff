// Small helpers shared by the public sale page and the admin page.

// Creates an element. Text is always inserted as text, never as HTML.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'className') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name !== 'list' && name in node) node[name] = value;
    else node.setAttribute(name, value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

// Formats an amount in the sale's currency, showing whole numbers cleanly.
export function money(amount, currency) {
  if (amount === 0) return 'Free';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

// Calls the site's API and turns failed requests into readable errors.
export async function api(path, options = {}) {
  const { json, ...request } = { credentials: 'same-origin', ...options };
  if (json !== undefined) {
    request.method = options.method || 'POST';
    request.headers = { 'Content-Type': 'application/json' };
    request.body = JSON.stringify(json);
  }
  const response = await fetch(path, request);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

// Applies the seller's chosen accent colour to the page.
export function applyAccent(color) {
  if (color) document.documentElement.style.setProperty('--accent', color);
}

// Wraps a form control in a label with a caption above it.
export function field(label, control) {
  return el('label', { className: 'field' }, el('span', { text: label }), control);
}

// Builds a button that asks for a second click before doing something permanent.
export function confirmButton(label, action) {
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
