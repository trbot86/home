# Recipe shopping

Use **Shop for this recipe** to choose ingredients and either an existing list or
**Create a new list**. A new list, recipe group, and ingredient entries are one
transaction and one undoable change. Original ingredient text and recipe
provenance are preserved. The list keeps the recipe's visibility.

Buying notes belong to the new list. When exporting to an existing list, notes
are attached to the selected entries without overwriting existing list notes.
List notes can also be edited from Shopping.

**Settings → Nearby shopping** stores a location and preferred stores separately
for each profile, shared across that profile's devices. Mark bulk stores as
preferred for larger orders. No deployment-specific location belongs in source.

**Check nearby stores** builds ingredient search links from those preferences.
Bulk stores appear when **Larger order** is selected. Opening a link sends its
search terms to the search provider. Saving a search adds an editable buying
note; it does not claim that an item is stocked. This version provides manual
store searches without claiming current stock.

Migrations 032 and 033 add list notes and profile preferences. Existing list
history without notes normalizes to an empty string, and old clients can rename
lists without erasing notes. The compound export restores lists before groups
and entries, and deletes them in the reverse order.


## Default store and exceptions

Set **Default store** in Nearby shopping settings. **Suggest sourcing** sends only
selected ingredient text, the default store and location to the existing isolated
Luna worker. It identifies likely specialty-store exceptions using general
knowledge; it does not search a retailer catalogue. Ordinary groceries and
uncertain cases remain covered by “Everything else is at [default store]”,
explicitly labelled as an assumption.

Only exceptions get individual alternative-search links. **Use sourcing notes**
copies this compact result into a durable, editable draft. Export saves it once
on the new list, or appends it to an existing list under the recipe name in the
same revision-guarded, undoable transaction. Changing the ingredient selection
requires updating or clearing those notes.

Migration 034 records each attempt before model dispatch. Refresh reads saved
results without calling the model. An exact retry returns the existing attempt;
a failed or interrupted attempt requires explicit retry and is never described
as a successful finding of no exceptions. Recipe/settings changes invalidate
results. Private records remain private; Secure recipes are excluded.

The worker accepts only two fixed purposes and reconstructs the prompt, input,
and output schema independently at the inference gateway. It retains its
existing filesystem/network isolation, no-tools request and output validation.
There is no database access, browsing tool, inherited conversation, or extra
household context. Structured responses are validated against offered keys;
see [OpenAI structured outputs guidance](https://developers.openai.com/api/docs/guides/structured-outputs).
