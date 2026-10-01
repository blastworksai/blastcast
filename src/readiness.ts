// CodexBWAI — browser-only, one-use outside-network readiness confirmation.
export {};
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
let token = location.hash.startsWith('#check=') ? location.hash.slice('#check='.length) : '';
if (!tokenPattern.test(token)) token = '';
history.replaceState(null, '', `${location.pathname}${location.search}`);

const form = document.getElementById('readiness-form') as HTMLFormElement;
const outside = document.getElementById('outside-network') as HTMLInputElement;
const secure = document.getElementById('secure-without-bypass') as HTMLInputElement;
const button = document.getElementById('confirm-readiness') as HTMLButtonElement;
const status = document.getElementById('readiness-status') as HTMLParagraphElement;

function fail(message: string): void {
  status.textContent = message;
  status.className = 'status error';
  button.disabled = true;
  token = '';
}

if (location.protocol !== 'https:') fail('This check must open over HTTPS. Ask the host for a new link.');
else if (!token) fail('This readiness link is invalid or already removed. Ask the host for a new link.');

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!token || !outside.checked || !secure.checked) {
    status.textContent = 'Confirm both statements before continuing.';
    status.className = 'status error';
    return;
  }
  button.disabled = true;
  status.textContent = 'Confirming with the host…';
  status.className = 'status';
  const credential = token;
  token = '';
  try {
    const response = await fetch('/api/readiness/confirm', {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ outsideNetwork: true, secureWithoutBypass: true }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('closed');
    status.textContent = 'Guest access confirmed. You can return to the host.';
    status.className = 'status success';
    outside.disabled = true;
    secure.disabled = true;
  } catch {
    fail('The host did not accept this check. Ask the host to start a new one.');
  }
});
