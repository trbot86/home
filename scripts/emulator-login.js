(async () => {
  const inputs = [...document.querySelectorAll('input')];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const [i, value] of ['http://10.0.2.2:3173', 'alex', 'local-demo-alex-2026'].entries()) {
    setter.call(inputs[i], value); inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
  }
  document.querySelector('form').requestSubmit();
  await new Promise(resolve => setTimeout(resolve, 3000));
  return document.body.innerText;
})()
