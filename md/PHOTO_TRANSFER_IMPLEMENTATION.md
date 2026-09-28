# Screenshot paste and image drop

Status: deployed on the private web host and Android download.

On desktop, paste a screenshot into the Inbox or App suggestions capture box, or
drop image files there. The shared Photos & receipts editor accepts the same
gestures, including while a caption has focus. Ordinary text paste and text/URL
drop retain browser behavior. The app only handles supplied file bytes: dropping
an image link is not an instruction to fetch its remote source.

Paste uses the clipboard event's files, without requesting clipboard-read access.
The form highlights while image files are dragged over it. Files dropped outside
a capture box/photo editor are intercepted so the browser does not navigate away;
a message explains where to drop them.

Both gestures and ordinary file selection validate the entire selection before
adding anything: PNG, JPEG or WebP, non-empty, at most 25 MB per file and twenty
photos total. A mixed unsupported/valid selection is rejected together. Storage
errors remain visible; a photo is shown in the draft only after the existing
platform adapter has persisted its bytes. A later storage failure can leave
earlier successfully saved photos in the draft, as with existing file selection.

## Durable editing and scope

`usePhotoTransfer` handles file-bearing events; `validatePhotoFiles` shares input
validation across the capture box and attachment editor. Neither introduces a
store, upload mechanism or new command. Inbox and suggestion captures retain
their distinct draft identities and visibility. Pasting does not submit a capture
or a record edit. The user still saves explicitly.

A synchronous intake lock prevents Ctrl+Enter, navigation or profile switching
from freezing/changing a capture while its photo bytes are being saved. Existing
photo editors reuse their queued captions and work lock. Their offline, stale,
pending and submitted states remain read-only. Offline new captures continue to
accept local photos and submit through the existing durable queue.

Android camera/gallery controls remain the primary native acquisition routes.
Desktop gesture hints are hidden on that host. A WebView can use a file-bearing
paste/drop event when its device exposes one; Android keyboard-specific clipboard
image support is not assumed or promised. No server or Android database migration
is needed.

## Verification

Four browser flows cover real ClipboardItem PNG writes and Ctrl+V, ordinary text
paste, reload/offline capture and eventual upload, mixed files/size/count limits,
file-navigation prevention, suggestion isolation, photo-editor captions and draft
recovery, read-only offline rejection, and delayed bytes racing Ctrl+Enter.
Eight existing Inbox, suggestions and attachment flows also pass, as do
typechecking, package boundaries and production builds. Screens were checked at
320/390/820/1440-pixel widths. The production Linux image passes all 225 package
tests; fourteen Android unit tests pass. The emulator update preserves its profile,
cached records, photo captures and editor buffers. The native photo-editor regression
checks Back/reload, partner media downloads, receipt history and cached images
with its fixture server offline. All test content is synthetic and isolated from
the household.

Source revision `67f5285` is deployed without a migration. Both profiles' nineteen
existing records and installation/recovery identity are preserved. SQLite
integrity and foreign-key checks pass. The online pre-release backup is verified
at the secondary location. Served web assets and APK bytes match the tested
artifacts. Read-only live checks confirm the capture hint and ordinary shopping
navigation without creating test content. Updating physical Android phones
remains a user step.
