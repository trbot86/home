# Thoughts

Thoughts holds long-lived notes outside Inbox. Create a thought directly or use
**To Thoughts** on an Inbox capture. A thought has a title, text, an optional
category and photos. Search, category and visibility filters keep the list compact;
phones open the selected thought in place of the list.

New thoughts default to Just me. Filing preserves the capture's visibility and
Secure status, copies photo placements, and retains a link to the source capture.
The filing is one atomic, reversible change. Sharing uses the existing preview
of connected records so source captures and history cannot be exposed silently.

Thoughts use the common record registry, attachment store, revision checks,
history and backup system. Migration `037_notes.sql` adds their relational payload;
existing Inbox records remain unchanged. Deleting a thought is reversible from the
Thoughts Deleted view or history. Existing phone caches without thoughts remain
readable, and old navigation requests gain the new section without changing the
order of existing sections.

Saved thoughts are readable offline. Changes require a connection; unfinished
editor text is stored on the device across closing and reopening the editor.
Conflicting edits preserve the draft and offer copying it before loading the
latest version. Automatic AI filing to Thoughts is outside this change.

Verification: isolated server tests cover access, sharing, conflicting revisions,
partner edits, photo filing, Secure inheritance, atomic undo, backup restoration
and historical media. Browser tests cover private defaults, categories, drafts
across reload, editing, history, deletion/restoration, photo filing and narrow
layouts. Contract tests cover pre-Thoughts navigation requests.
