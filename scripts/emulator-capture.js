(async () => {
  const field = document.querySelector('textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Native offline capture survives process restart');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 700));
  field.closest('form').requestSubmit();
  await new Promise(resolve => setTimeout(resolve, 1200));
  const result = await Capacitor.Plugins.Household.invoke({ method: 'state', args: {} });
  const pending = result.value.drafts.find(draft => draft.text === 'Native offline capture survives process restart');
  if (pending?.state !== 'SUBMITTED' || !pending.frozenHash) throw new Error('Native queue did not freeze offline capture');
  return { draftId: pending.draftId, frozenJson: pending.frozenJson, frozenHash: pending.frozenHash };
})()
