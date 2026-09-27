// Development-only CDP helper for the isolated emulator's debug WebView.
// Forward its socket to 9223 using the project ADB server before running.
import { readFile } from 'node:fs/promises';
const targets = await (await fetch('http://127.0.0.1:9223/json')).json();
const target = targets.find(item => item.type === 'page');
if (!target) throw new Error('No debug WebView page');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const script = process.argv[2] ? await readFile(process.argv[2], 'utf8') : 'document.body.innerText';
const timer = setTimeout(() => { socket.close(); process.exitCode = 1; }, 45000);
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id !== 1) return;
  clearTimeout(timer);
  if (message.result?.exceptionDetails || message.error) { console.error(JSON.stringify(message)); process.exitCode = 1; }
  else console.log(JSON.stringify(message.result?.result?.value, null, 2));
  socket.close();
};
socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: script, awaitPromise: true, returnByValue: true } }));
