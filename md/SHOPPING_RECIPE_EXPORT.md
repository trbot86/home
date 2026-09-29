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
store searches, not AI recommendations or live inventory lookup.

Migrations 032 and 033 add list notes and profile preferences. Existing list
history without notes normalizes to an empty string, and old clients can rename
lists without erasing notes. The compound export restores lists before groups
and entries, and deletes them in the reverse order.
