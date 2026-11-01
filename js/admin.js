const form = document.querySelector('#adminForm');
const password = document.querySelector('#adminPassword');
const button = document.querySelector('#rebuildButton');
const status = document.querySelector('#adminStatus');
const wait = () => new Promise(resolve => setTimeout(resolve, 3000));

form.addEventListener('submit', async event => {
  event.preventDefault();
  button.disabled = true;
  status.textContent = 'Authenticating…';
  try {
    const response = await fetch('/admin/api/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    password.value = '';
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('Deployment administration is unavailable. Check the admin service.');
    }
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not request a rebuild.');
    status.textContent = job.message;
    while (true) {
      await wait();
      try {
        const result = await fetch('/admin/api/status', {
          headers: { 'X-Emage-Job-Token': job.token },
        });
        if (result.status === 401) throw new Error('Session expired. Enter the password again to check or retry.');
        if (!result.ok) { status.textContent = 'Services are being replaced. Reconnecting…'; continue; }
        const progress = await result.json();
        status.textContent = progress.message;
        if (['succeeded', 'failed'].includes(progress.state)) break;
      } catch (error) {
        if (error.message.startsWith('Session expired')) throw error;
        status.textContent = 'Services are being replaced. Reconnecting…';
      }
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    password.value = '';
    button.disabled = false;
  }
});
