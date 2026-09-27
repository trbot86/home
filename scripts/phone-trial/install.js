document.getElementById('copy').addEventListener('click', async () => {
  const status = document.getElementById('copy-status');
  try {
    await navigator.clipboard.writeText(document.getElementById('address').textContent);
    status.textContent = 'Copied. Paste this address into Our place.';
  } catch {
    status.textContent = 'Select and copy the server address above.';
  }
});
