export default async function teardown() {
  const response = await fetch('http://127.0.0.1:4174/stop', { method: 'POST', headers: { 'x-test-token': process.env['OUR_PLACE_TEST_TOKEN']! } });
  if (!response.ok) throw new Error('Test fixture did not accept shutdown');
  // Wait for normal server exit before Playwright's Windows process-tree cleanup.
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await fetch('http://127.0.0.1:4173/health'); }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Test fixture did not stop');
}
