import { NavigationOrderEditor } from './NavigationOrderEditor.js';
import { navigationItems } from './navigation.js';
import { Photo } from './Photo.js';
import { EntryDialog } from './EntryDialog.js';
import { suggestionCompleted, suggestionStatus } from './suggestions/status.js';
import { SuggestionCompletionButton } from './suggestions/SuggestionCompletionButton.js';
import { SuggestionCardUpdate, suggestionUnread } from './suggestions/SuggestionCardUpdate.js';
import { SuggestionReleasePanel } from './suggestions/SuggestionReleasePanel.js';
import { Storage } from './Storage.js';
import { AppUpdates } from './AppUpdates.js';
import { useAppVersion } from './useAppVersion.js';
import { CalendarSettings } from './calendars/CalendarSettings.js';
import { PersonalAgenda } from './calendars/PersonalAgenda.js';
import { LinkedText } from './LinkedText.js';
import { NoteLinksProvider, noteIdFromUrl } from './NoteLinks.js';
import { date } from './format.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState, Draft } from '@our-place/client';
import {
  categoryOf,
  emptyShopping,
  emptyTasks,
  emptyHome,
  emptyRecipes,
  emptyProjects,
  emptyAgenda,
  emptySuggestions,
  type CommandKind,
  type CommandOutcome,
  type EntryCategory,
  type InboxEntry,
} from '@our-place/contracts';
import { Shopping } from './shopping/Shopping.js';
import { shoppingRecords } from './shopping/shared.js';
import { Tasks } from './tasks/Tasks.js';
import { Home } from './home/Home.js';
import { Food } from './food/Food.js';
import { Projects } from './projects/Projects.js';
import type { RecordReference } from './RecordReferences.js';
import { taskRecords } from './tasks/shared.js';
import { Icon } from './Icon.js';
import { BackupPanel } from './BackupPanel.js';
import { SignIn } from './SignIn.js';
import { CaptureMedia } from './CaptureMedia.js';
import { ProfileControl } from './ProfileControl.js';
import { FilingDialog } from './inbox/FilingDialog.js';
import { FilingLinks, CaptureSources } from './inbox/FilingLinks.js';
import { filingOf } from '@our-place/contracts';
import { widgetNavigationError, type WidgetNavigation } from '@our-place/client';
import { Activity } from './activity/Activity.js';
import { useFileDropGuard, usePhotoTransfer } from './usePhotoTransfer.js';
import { validatePhotoFiles } from './photo-input.js';

const emptyState: ClientState = {
  session: null,
  entries: [],
  shopping: emptyShopping(),
  tasks: emptyTasks(),
  home: emptyHome(),
  recipes: emptyRecipes(),
  projects: emptyProjects(),
  suggestions: emptySuggestions(),
  recipeImports: [],
  views: [],
  agenda: emptyAgenda(),
  drafts: [],
  online: navigator.onLine,
  sampledAt: null,
  pendingEdits: [],
  recoveryRequired: false,
};
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Your saved draft is still here.';
type View =
  | 'inbox'
  | 'suggestions'
  | 'shopping'
  | 'tasks'
  | 'home'
  | 'food'
  | 'projects'
  | 'trash'
  | 'storage'
  | 'activity'
  | 'agenda';
function unfinishedDraft(drafts: Draft[], category: EntryCategory) {
  const candidates = drafts.filter(
    (d) => !d.replyTarget && d.state === 'DRAFT' && categoryOf(d) === category,
  );
  return candidates.find((d) => d.text.trim() || d.attachments.length) ?? candidates[0];
}

export function App({ client }: { client: ClientPlatform }) {
  const [state, setState] = useState<ClientState>(emptyState);
  const [switching, setSwitching] = useState(false);
  const appVersion = useAppVersion(client, state.online);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>(() =>
    new URL(window.location.href).searchParams.get('settings') === 'calendars' ? 'storage' : 'inbox',
  );
  const [editingNavigation, setEditingNavigation] = useState(false);
  const navigationView = state.views.find(
    (v) =>
      v.kind === 'navigation' &&
      v.scopeId === state.session?.scopes.find((s) => s.kind === 'private')?.scopeId,
  );
  const navigationOrder =
    navigationView?.kind === 'navigation' ? navigationView.order : navigationItems.map((item) => item.id);
  const navigationRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const reveal = () => {
      const nav = navigationRef.current;
      if (nav && nav.scrollWidth > nav.clientWidth)
        nav.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    };
    reveal();
    window.addEventListener('resize', reveal);
    return () => window.removeEventListener('resize', reveal);
  }, [view, navigationOrder.join(), switching, loading]);
  const category: EntryCategory = view === 'suggestions' ? 'app_suggestion' : 'inbox';
  const navigationLock = useRef(false);
  const [scope, setScope] = useState('all');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(24);
  const [sort, setSort] = useState('newest');
  const [inboxFilter, setInboxFilter] = useState('unfiled');
  const [suggestionFilter, setSuggestionFilter] = useState<'active' | 'completed'>('active');
  const [filingId, setFilingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{
    label: string;
    recordId: string;
    changeSetId: string;
    redo?: boolean;
  } | null>(null);
  const reversal = useRef<typeof toast>(null);
  const reversalLock = useRef(false);
  const [selected, setSelected] = useState<{ id: string; history: boolean } | null>(null);
  const [recipeTarget, setRecipeTarget] = useState<string | null>(null);
  const [linkedTarget, setLinkedTarget] = useState<string | null>(null);
  const [widgetTarget, setWidgetTarget] = useState<WidgetNavigation | null>(null);
  const widgetNavigationLock = useRef(false);
  function openLinkedRecord(reference: RecordReference) {
    setWidgetTarget(null);
    if (reference.kind === 'inbox') {
      void openNote(reference.recordId).catch(() => {});
      return;
    }
    setRecipeTarget(null);
    setLinkedTarget(reference.recordId);
    setView(
      reference.kind.startsWith('task')
        ? 'tasks'
        : reference.kind.startsWith('project')
          ? 'projects'
          : reference.kind.startsWith('recipe')
            ? 'food'
            : ['home_asset', 'maintenance_record'].includes(reference.kind)
              ? 'home'
              : 'shopping',
    );
  }
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState('');
  const [captureScope, setCaptureScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState(false);
  const submitLock = useRef(false);
  const photoLock = useRef(false);
  const initialiseLock = useRef(false);
  const loadGeneration = useRef(0);
  const noteLoadGeneration = useRef(0);
  const currentOwner = useRef('');
  currentOwner.current = switching
    ? ''
    : `${state.session?.clientId ?? ''}:${state.session?.serverEpoch ?? ''}`;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const showError = (value: unknown) => setError(message(value));
  useFileDropGuard(showError);
  const transfer = usePhotoTransfer({
    disabledReason:
      !draft || draft.state !== 'DRAFT' || busy || switching
        ? 'Finish the current action before adding photos.'
        : null,
    onFiles: addPhotos,
    onError: showError,
  });
  async function openNote(id: string) {
    if (!state.session || switching) return;
    const owner = currentOwner.current;
    const generation = ++noteLoadGeneration.current;
    try {
      let latest = await client.state();
      if (latest.online) {
        try {
          await client.refresh();
        } catch (error) {
          latest = await client.state();
          if (latest.online) throw error;
        }
        latest = await client.state();
      }
      if (
        generation !== noteLoadGeneration.current ||
        owner !== currentOwner.current ||
        owner !== `${latest.session?.clientId ?? ''}:${latest.session?.serverEpoch ?? ''}`
      )
        return;
      const entry = latest.entries.find((item) => item.inboxId === id);
      if (!entry)
        throw new Error(
          latest.online
            ? 'This note is unavailable for your profile. It may have been removed.'
            : 'This note is not saved on this device. Reconnect to the household server and try again.',
        );
      setState(latest);
      setSelected({ id, history: false });
      setError('');
    } catch (error) {
      if (generation === noteLoadGeneration.current && owner === currentOwner.current) {
        showError(error);
        throw error;
      }
    }
  }
  const openNoteRef = useRef(openNote);
  openNoteRef.current = openNote;
  useEffect(() => {
    if (
      !client.takeWidgetNavigation ||
      !state.session ||
      busy ||
      saving ||
      switching ||
      widgetNavigationLock.current
    )
      return;
    const owner = currentOwner.current;
    widgetNavigationLock.current = true;
    void (async () => {
      const request = await client.takeWidgetNavigation!();
      if (!request) return;
      let latest = await client.state();
      if (latest.online) {
        await client.refresh().catch(() => {});
        latest = await client.state();
      }
      if (owner !== currentOwner.current) return;
      const problem = widgetNavigationError(latest, request);
      if (problem) {
        showError(new Error(problem));
        return;
      }
      setState(latest);
      setSelected(null);
      setFilingId(null);
      setRecipeTarget(null);
      setLinkedTarget(request.recordId);
      setWidgetTarget(request);
      setView('tasks');
      setError('');
    })()
      .catch(showError)
      .finally(() => {
        widgetNavigationLock.current = false;
      });
  }, [client, state, busy, saving, switching]);
  useEffect(() => {
    if (!state.session || switching) return;
    const followLocation = () => {
      const id = noteIdFromUrl(window.location.href, window.location.origin);
      if (id) void openNoteRef.current(id).catch(() => {});
    };
    followLocation();
    window.addEventListener('popstate', followLocation);
    return () => window.removeEventListener('popstate', followLocation);
  }, [state.session?.clientId, switching]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const generation = ++loadGeneration.current;
      void client
        .state()
        .then((value) => {
          if (alive && generation === loadGeneration.current) {
            setState(value);
            setLoading(false);
          }
        })
        .catch(showError);
    };
    const sync = () => {
      void client
        .state()
        .then((value) => (value.session ? client.sync() : undefined))
        .catch((error) => {
          if (message(error) !== 'server unreachable') showError(error);
        });
      load();
    };
    const off = client.subscribe(load);
    load();
    sync();
    const interval = window.setInterval(sync, 15000);
    window.addEventListener('online', sync);
    window.addEventListener('offline', load);
    window.addEventListener('focus', sync);
    return () => {
      alive = false;
      off();
      clearInterval(interval);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', load);
      window.removeEventListener('focus', sync);
    };
  }, [client]);
  useEffect(() => {
    if (switching) return;
    if (!state.session) {
      setDraft(null);
      setText('');
      return;
    }
    if (draft || initialiseLock.current) return;
    initialiseLock.current = true;
    const privateScope = state.session.scopes.find((s) => s.kind === 'private')!.scopeId;
    const existing = unfinishedDraft(state.drafts, category);
    void (existing ? Promise.resolve(existing) : client.createDraft(privateScope, category))
      .then((value) => {
        setDraft(value);
        setText(value.text);
        setCaptureScope(value.scopeId);
      })
      .catch(showError)
      .finally(() => {
        initialiseLock.current = false;
      });
  }, [state.session, state.drafts, draft, client, switching, category]);
  useEffect(() => {
    if (!draft) return;
    const latest = state.drafts.find((item) => item.draftId === draft.draftId);
    if (latest?.state === 'DRAFT')
      setDraft((current) =>
        current?.draftId === latest.draftId && current.revision < latest.revision ? latest : current,
      );
  }, [state.drafts, draft]);
  const secureSave = useRef<Promise<void> | null>(null);
  useEffect(() => {
    secureSave.current = null;
  }, [draft?.draftId]);
  async function saveDraft(value: string, scopeId = captureScope, secure?: boolean) {
    if (!draft) return;
    setSaving(true);
    setLocalError(false);
    try {
      const updated = await client.saveDraft(draft.draftId, value, scopeId, secure);
      setDraft((current) =>
        current?.draftId === updated.draftId && current.revision < updated.revision ? updated : current,
      );
    } catch (error) {
      setLocalError(true);
      showError(error);
      throw error;
    } finally {
      setSaving(false);
    }
  }
  async function switchProfile(username: string) {
    if (busy || saving || switching || photoLock.current) return;
    setSwitching(true);
    setError('');
    let selectionStarted = false;
    try {
      if (draft?.state === 'DRAFT') await client.saveDraft(draft.draftId, text, captureScope);
      selectionStarted = true;
      await client.login(username, '');
    } catch (error) {
      showError(error);
    } finally {
      // A lost refresh after successful selection must not leave the old profile's editor on screen.
      if (selectionStarted) {
        setDraft(null);
        setText('');
        setSelected(null);
        setFilingId(null);
        setInboxFilter('unfiled');
        setSuggestionFilter('active');
        setRecipeTarget(null);
        setLinkedTarget(null);
        setWidgetTarget(null);
        setToast(null);
        reversal.current = null;
        setScope('all');
        setSearch('');
        setView('inbox');
        loadGeneration.current++;
        try {
          setState(await client.state());
        } catch (error) {
          showError(error);
        }
      }
      setSwitching(false);
    }
  }
  async function navigate(nextView: View) {
    if (busy || switching || navigationLock.current || photoLock.current || !state.session) return;
    navigationLock.current = true;
    setBusy(true);
    try {
      setWidgetTarget(null);
      if (nextView === 'inbox' || nextView === 'suggestions') {
        const nextCategory = nextView === 'suggestions' ? 'app_suggestion' : 'inbox';
        if (!draft || categoryOf(draft) !== nextCategory) {
          if (draft?.state === 'DRAFT') await client.saveDraft(draft.draftId, text, captureScope);
          const latest = await client.state();
          const existing = unfinishedDraft(latest.drafts, nextCategory);
          const next =
            existing ??
            (await client.createDraft(
              state.session.scopes.find((s) => s.kind === 'private')!.scopeId,
              nextCategory,
            ));
          setDraft(next);
          setText(next.text);
          setCaptureScope(next.scopeId);
        }
      }
      setScope('all');
      setSearch('');
      setView(nextView);
      setSuggestionFilter('active');
      setRecipeTarget(null);
      setLinkedTarget(null);
    } catch (error) {
      showError(error);
    } finally {
      navigationLock.current = false;
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft || submitLock.current || photoLock.current || busy || switching) return;
    submitLock.current = true;
    setBusy(true);
    try {
      await secureSave.current;
      await saveDraft(text);
      await client.submitDraft(draft.draftId);
      setInboxFilter('unfiled');
      setSuggestionFilter('active');
      const next = await client.createDraft(
        state.session!.scopes.find((scope) => scope.kind === 'private')!.scopeId,
        categoryOf(draft),
      );
      setDraft(next);
      setCaptureScope(next.scopeId);
      setText('');
      setError('');
    } catch (error) {
      showError(error);
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  }
  async function addPhotos(files: File[]) {
    if (!draft || !files.length) return;
    if (photoLock.current || busy || switching || draft.state !== 'DRAFT') {
      showError(new Error('Finish the current action before adding photos.'));
      return;
    }
    photoLock.current = true;
    setBusy(true);
    try {
      validatePhotoFiles(files, draft.attachments.length);
      await saveDraft(text);
      let next = draft;
      for (const file of files) next = await client.addPhoto(draft.draftId, file);
      setDraft(next);
      setError('');
    } catch (error) {
      showError(error);
    } finally {
      photoLock.current = false;
      setBusy(false);
    }
  }
  async function runCommand(
    entry: InboxEntry | { recordId: string },
    kind: CommandKind,
    args: unknown,
    label: string,
    expectedServerEpoch = state.session!.serverEpoch,
  ) {
    try {
      const recordId = 'inboxId' in entry ? entry.inboxId : entry.recordId;
      const outcome = await client.command(recordId, kind, args, expectedServerEpoch);
      acceptOutcome(recordId, outcome, label, kind);
      return outcome;
    } catch (error) {
      showError(error);
      return null;
    }
  }
  function acceptOutcome(
    recordId: string,
    outcome: CommandOutcome,
    label: string,
    kind: CommandKind = 'SetRecordAttachments',
  ) {
    if (outcome.status === 'Applied') {
      if (outcome.changeSetId) {
        const action = {
          label,
          recordId,
          changeSetId: outcome.changeSetId,
          ...(kind === 'UndoChangeSet' ? { redo: true } : {}),
        };
        reversal.current = action;
        setToast(action);
      }
      setError('');
    } else if (outcome.status === 'Rejected')
      showError(
        new Error(
          outcome.code === 'revision_conflict'
            ? 'This entry changed. Your text is kept; reload the latest version before saving.'
            : outcome.code.replaceAll('_', ' '),
        ),
      );
    else
      showError(
        new Error(
          outcome.status === 'RecoveryRequired'
            ? 'The server was restored. Your pending work is kept for reconciliation.'
            : 'Waiting for the server. This action will be checked again.',
        ),
      );
  }
  const activeEntries = state.entries
    .filter(
      (entry) =>
        (view === 'trash' ? entry.deletedAt !== null : entry.deletedAt === null) &&
        (view === 'trash' || categoryOf(entry) === category) &&
        (view !== 'suggestions' ||
          suggestionCompleted(state.suggestions, entry.inboxId) === (suggestionFilter === 'completed')) &&
        (view !== 'inbox' ||
          inboxFilter === 'all' ||
          (filingOf(entry).filedAt !== null) === (inboxFilter === 'filed')) &&
        (scope === 'all' || entry.scopeId === scope) &&
        entry.text.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => (sort === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
  const pending = state.drafts.filter(
    (d) =>
      !d.replyTarget &&
      categoryOf(d) === category &&
      d.draftId !== draft?.draftId &&
      (d.text.trim() || d.attachments.length),
  );
  const selectedEntry = state.entries.find((e) => e.inboxId === selected?.id);
  const filingEntry = state.entries.find((e) => e.inboxId === filingId);
  const sharedScope = state.session?.scopes.find((s) => s.kind === 'shared')?.scopeId;
  useEffect(
    () =>
      client.onBack?.(() => {
        if (selected) {
          setSelected(null);
          return true;
        }
        if (busy || switching) return true;
        if (state.session && view !== 'inbox') {
          void navigate('inbox');
          return true;
        }
        return false;
      }),
    [client, selected, view, busy, switching, draft, text, captureScope, state.session],
  );
  async function reverseLatest() {
    const action = reversal.current;
    if (!action || !state.online || reversalLock.current) return;
    const entry =
      state.entries.find((e) => e.inboxId === action.recordId) ??
      shoppingRecords(state.shopping).find((record) => record.recordId === action.recordId) ??
      taskRecords(state.tasks).find((record) => record.recordId === action.recordId) ??
      [...state.home.assets, ...state.home.serviceRecords].find(
        (record) => record.recordId === action.recordId,
      ) ??
      [...state.recipes.recipes, ...state.recipes.collections, ...state.recipes.cookingRecords].find(
        (record) => record.recordId === action.recordId,
      ) ??
      [...state.projects.projects, ...state.projects.pages].find(
        (record) => record.recordId === action.recordId,
      );
    if (!entry || state.pendingEdits.includes(action.recordId)) return;
    reversalLock.current = true;
    try {
      await runCommand(
        entry,
        action.redo ? 'RedoChangeSet' : 'UndoChangeSet',
        { changeSetId: action.changeSetId },
        action.redo ? 'Change redone' : 'Change undone',
      );
    } finally {
      reversalLock.current = false;
    }
  }
  useEffect(() => {
    const undoKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== 'z'
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"]'))
      )
        return;
      if (
        !reversal.current ||
        !!reversal.current.redo !== event.shiftKey ||
        !state.online ||
        busy ||
        switching ||
        selected ||
        document.querySelector('dialog[open]')
      )
        return;
      event.preventDefault();
      void reverseLatest();
    };
    window.addEventListener('keydown', undoKey);
    return () => window.removeEventListener('keydown', undoKey);
  }, [state, busy, switching, selected]);
  if (loading) return <div className="loading">Opening our place…</div>;
  if (switching)
    return (
      <div className="loading" role="status">
        Opening your profile…
      </div>
    );
  return (
    <NoteLinksProvider
      client={client}
      entries={state.entries}
      open={openNote}
      key={`${state.session?.clientId ?? ''}:${state.session?.serverEpoch ?? ''}`}
    >
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss message" onClick={() => setError('')}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {!state.session ? (
        <SignIn client={client} onError={showError} />
      ) : (
        <div className="app-shell">
          <aside className="sidebar">
            <a
              className="brand"
              href="#"
              onClick={(event) => {
                event.preventDefault();
                void navigate('inbox');
              }}
            >
              <span className="brand-mark">
                <Icon name="home" />
              </span>
              Our place<span className="brand-dot">.</span>
            </a>
            <p className="sidebar-caption">Room for everyday life</p>
            <nav ref={navigationRef} aria-label="Main navigation">
              {navigationItems
                .slice()
                .sort((a, b) => navigationOrder.indexOf(a.id) - navigationOrder.indexOf(b.id))
                .map((item) => (
                  <button
                    key={item.id}
                    aria-label={item.label}
                    aria-current={view === item.id ? 'page' : undefined}
                    disabled={busy || switching}
                    onClick={() => {
                      void navigate(item.id);
                    }}
                  >
                    <Icon name={item.icon} />
                    <span className="nav-label-full">{item.label}</span>
                    <span className="nav-label-compact" aria-hidden="true">
                      {item.compactLabel}
                    </span>
                    {item.id === 'inbox' && (
                      <span className="nav-count">
                        {
                          state.entries.filter(
                            (e) => !e.deletedAt && categoryOf(e) === 'inbox' && filingOf(e).filedAt === null,
                          ).length
                        }
                      </span>
                    )}
                  </button>
                ))}
            </nav>
            <div className="sidebar-bottom">
              <button
                className="suggestion"
                aria-label="App suggestions"
                aria-current={view === 'suggestions' ? 'page' : undefined}
                disabled={busy || switching}
                onClick={() => {
                  void navigate('suggestions');
                }}
              >
                <Icon name="plus" />
                App suggestions
                <span className="nav-count">
                  {
                    state.entries.filter(
                      (e) =>
                        !e.deletedAt &&
                        categoryOf(e) === 'app_suggestion' &&
                        !suggestionCompleted(state.suggestions, e.inboxId),
                    ).length
                  }
                </span>
              </button>
              <ProfileControl
                client={client}
                person={state.session.person}
                online={state.online}
                disabled={!state.online || busy || saving || !draft}
                onSwitch={switchProfile}
                onError={showError}
              />
            </div>
          </aside>
          <main className={`main main-${view}`}>
            {view === 'inbox' && (
              <AppUpdates
                client={client}
                online={state.online}
                onError={showError}
                version={appVersion}
                notice
              />
            )}
            <header className="page-header">
              <div>
                <p className="eyebrow">Your household, together</p>
                <h1>
                  {view === 'activity'
                    ? 'The things we got done.'
                    : view === 'agenda'
                      ? 'A little room for today.'
                      : view === 'inbox'
                        ? 'A place for the little things.'
                        : view === 'suggestions'
                          ? 'Make our place a little better.'
                          : view === 'shopping'
                            ? 'A little less to remember.'
                            : view === 'tasks'
                              ? 'Tasks, at your pace.'
                              : view === 'projects'
                                ? 'Room for the bigger ideas.'
                                : view === 'food'
                                  ? 'Good food, good company.'
                                  : view === 'home'
                                    ? 'Care for the place we call home.'
                                    : view === 'trash'
                                      ? 'Room for second thoughts.'
                                      : 'Your household settings.'}
                </h1>
                <p>
                  {view === 'activity'
                    ? 'A quiet record of everyday effort, together.'
                    : view === 'agenda'
                      ? 'Your calendar, your priorities, and what needs a little attention.'
                      : view === 'inbox'
                        ? 'Catch a thought now. Figure out the details later.'
                        : view === 'suggestions'
                          ? 'Ideas, rough edges, and things you’d like this app to do.'
                          : view === 'shopping'
                            ? 'What we need, what we love, and what’s running low.'
                            : view === 'tasks'
                              ? 'A plan for what matters, and a record of what got done.'
                              : view === 'projects'
                                ? 'Plans, inspiration and the next small step, all together.'
                                : view === 'food'
                                  ? 'Recipes to try, favourites to return to, and notes that make them ours.'
                                  : view === 'home'
                                    ? 'The details worth keeping, and the care that keeps things going.'
                                    : view === 'trash'
                                      ? 'Deleted entries keep their history. Bring one back when you need it.'
                                      : 'Calendar connections, storage, backups and app updates.'}
                </p>
              </div>
              <div className="connection">
                <span className={`status-dot ${state.online ? '' : 'offline'}`} />
                <span>{state.online ? 'Connected' : 'Offline · on this device'}</span>
                <button
                  aria-label="Refresh and sync"
                  onClick={() => {
                    void client.sync().catch(showError);
                  }}
                >
                  <Icon name="refresh" size={16} />
                </button>
              </div>
            </header>
            {state.recoveryRequired && (
              <div className="notice">
                <Icon name="clock" />
                <p>
                  The server was restored from a backup. Your local drafts and pending requests have been
                  kept. Older pending requests need reconciliation.
                </p>
                {state.pendingEdits.length > 0 && (
                  <button
                    onClick={() => {
                      void client.reconcileEdits().catch(showError);
                    }}
                  >
                    Resolve old edits · keep my text
                  </button>
                )}
              </div>
            )}
            {view === 'activity' ? (
              <Activity client={client} state={state} onRecord={openLinkedRecord} />
            ) : view === 'agenda' ? (
              <PersonalAgenda
                client={client}
                state={state}
                run={runCommand}
                onError={showError}
                onAllTasks={() => {
                  setLinkedTarget(null);
                  setView('tasks');
                }}
                onRecipe={(id) => {
                  setRecipeTarget(id);
                  setLinkedTarget(null);
                  setView('food');
                }}
                onProject={(id) => {
                  setLinkedTarget(id);
                  setView('projects');
                }}
                onRecord={openLinkedRecord}
                onSettings={() => setView('storage')}
                onTask={(id) => {
                  setWidgetTarget(null);
                  setLinkedTarget(id);
                  setView('tasks');
                }}
              />
            ) : view === 'tasks' ? (
              <Tasks
                key={widgetTarget?.recordId === linkedTarget ? widgetTarget.token : (linkedTarget ?? 'tasks')}
                initialRecordId={linkedTarget}
                initialAction={widgetTarget?.recordId === linkedTarget ? widgetTarget.action : 'show'}
                client={client}
                state={state}
                run={runCommand}
                onError={showError}
                onPhotosSaved={acceptOutcome}
                onOpenRecipe={(id) => {
                  setRecipeTarget(id);
                  setView('food');
                }}
              />
            ) : view === 'shopping' ? (
              <Shopping
                key={linkedTarget ?? 'shopping'}
                initialRecordId={linkedTarget}
                client={client}
                state={state}
                run={runCommand}
                onPhotosSaved={acceptOutcome}
                onError={showError}
                onOpenRecipe={(id) => {
                  setRecipeTarget(id);
                  setView('food');
                }}
              />
            ) : view === 'home' ? (
              <Home
                key={linkedTarget ?? 'home'}
                initialRecordId={linkedTarget}
                client={client}
                state={state}
                run={runCommand}
                onError={showError}
                onPhotosSaved={acceptOutcome}
              />
            ) : view === 'food' ? (
              <Food
                key={recipeTarget ?? linkedTarget ?? 'food'}
                initialRecordId={linkedTarget}
                client={client}
                state={state}
                run={runCommand}
                onError={showError}
                onPhotosSaved={acceptOutcome}
                initialRecipeId={recipeTarget}
                onOpenShopping={() => setView('shopping')}
              />
            ) : view === 'projects' ? (
              <Projects
                key={linkedTarget ?? 'projects'}
                initialRecordId={linkedTarget}
                client={client}
                state={state}
                run={runCommand}
                onError={showError}
                onPhotosSaved={acceptOutcome}
                onOpenRecord={openLinkedRecord}
              />
            ) : view === 'storage' ? (
              <>
                <section className="storage">
                  <h2>Navigation order</h2>
                  <p>Arrange the sections for your profile. Your order syncs across your devices.</p>
                  <button onClick={() => setEditingNavigation(true)}>Reorder navigation</button>
                </section>
                {editingNavigation && (
                  <NavigationOrderEditor
                    client={client}
                    state={state}
                    view={navigationView?.kind === 'navigation' ? navigationView : undefined}
                    run={runCommand}
                    close={() => setEditingNavigation(false)}
                    onError={showError}
                  />
                )}
                <CalendarSettings client={client} state={state} run={runCommand} />
                <Storage client={client} state={state} onError={showError} />
                <AppUpdates client={client} online={state.online} onError={showError} version={appVersion} />
                {state.session.isAdministrator && (
                  <BackupPanel client={client} online={state.online} onError={showError} />
                )}
              </>
            ) : (
              <>
                {(view === 'inbox' || view === 'suggestions') && draft && (
                  <form
                    className={`capture ${transfer.dragging ? 'photo-dragging' : ''}`}
                    aria-label={view === 'suggestions' ? 'Suggestion capture' : 'Inbox capture'}
                    {...transfer.handlers}
                    onSubmit={(event) => {
                      void submit(event);
                    }}
                    onKeyDown={(event) => {
                      if (
                        (event.ctrlKey || event.metaKey) &&
                        event.key === 'Enter' &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        event.currentTarget.requestSubmit();
                      }
                    }}
                  >
                    <div className="capture-heading">
                      <span className="capture-icon">
                        <Icon name="plus" />
                      </span>
                      <label htmlFor="capture-text">
                        {view === 'suggestions' ? 'Suggest an improvement' : 'What’s on your mind?'}
                      </label>
                      <span className="draft-state" aria-live="polite">
                        {localError
                          ? 'Draft not saved'
                          : saving || busy
                            ? 'Saving draft…'
                            : 'Draft saved on this device'}
                      </span>
                    </div>
                    <textarea
                      id="capture-text"
                      ref={textRef}
                      value={text}
                      maxLength={20000}
                      disabled={busy}
                      placeholder={
                        view === 'suggestions'
                          ? 'What could work better? Add a screenshot if it helps…'
                          : 'A thought, a link, something for the house…'
                      }
                      onChange={(event) => {
                        setText(event.target.value);
                        void saveDraft(event.target.value).catch(() => {});
                      }}
                      rows={3}
                    />
                    {draft.attachments.length > 0 && (
                      <div className="capture-photos">
                        {draft.attachments.map((attachment) => (
                          <div key={attachment.mediaId}>
                            <Photo client={client} id={attachment.mediaId} />
                            <button
                              type="button"
                              aria-label="Remove photo"
                              disabled={busy}
                              onClick={() => {
                                void client
                                  .removePhoto(draft.draftId, attachment.mediaId)
                                  .then(setDraft)
                                  .catch(showError);
                              }}
                            >
                              <Icon name="close" size={16} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {!client.acquirePhoto && (
                      <p className="photo-transfer-hint fine">
                        {transfer.dragging
                          ? 'Drop to add photos'
                          : 'Paste a screenshot here or drop PNG, JPEG or WebP files.'}
                      </p>
                    )}
                    <div className="capture-footer">
                      <div className="capture-tools">
                        <CaptureMedia
                          client={client}
                          draftId={draft.draftId}
                          category={categoryOf(draft)}
                          busy={busy}
                          addPhotos={addPhotos}
                          onError={showError}
                        />
                      </div>
                      {categoryOf(draft) === 'inbox' && (
                        <label>
                          <input
                            type="checkbox"
                            checked={draft.secure ?? false}
                            disabled={busy || saving}
                            onChange={(event) => {
                              const work = saveDraft(text, captureScope, event.target.checked);
                              secureSave.current = work;
                              void work.catch(() => {});
                            }}
                          />
                          Secure — exclude from AI context
                        </label>
                      )}
                      <div className="capture-submit">
                        <select
                          aria-label="Who can see this capture"
                          value={captureScope}
                          disabled={busy}
                          onChange={(event) => {
                            setCaptureScope(event.target.value);
                            void saveDraft(text, event.target.value).catch(() => {});
                          }}
                        >
                          {state.session.scopes.map((s) => (
                            <option key={s.scopeId} value={s.scopeId}>
                              {s.kind === 'shared' ? 'Shared' : 'Just me'}
                            </option>
                          ))}
                        </select>
                        <span className="keyboard-hint">Ctrl ↵</span>
                        <button
                          className="primary"
                          disabled={busy || (!text.trim() && !draft.attachments.length)}
                        >
                          {busy ? 'Saving…' : view === 'suggestions' ? 'Save suggestion' : 'Save to inbox'}
                          <Icon name="arrow" size={17} />
                        </button>
                      </div>
                    </div>
                  </form>
                )}
                {pending.length > 0 && (
                  <section className="pending-section" aria-label="Local drafts and pending captures">
                    <div className="section-heading">
                      <h2>On this device</h2>
                      <span className="fine">Safe here, with clear next steps</span>
                    </div>
                    {pending.map((item) => (
                      <article className="pending-card" key={item.draftId}>
                        <Icon name={item.state === 'DRAFT' ? 'inbox' : 'clock'} />
                        <div>
                          <p className="entry-text">
                            <LinkedText client={client} text={item.text || 'Photo capture'} />
                          </p>
                          <span className="fine">
                            {item.state === 'DRAFT'
                              ? 'Unfinished draft · not submitted'
                              : item.state === 'SUBMITTED'
                                ? 'Waiting for confirmation · kept unchanged for retry'
                                : item.state === 'ACKNOWLEDGED'
                                  ? 'Saved on the server · waiting to refresh'
                                  : `Needs a correction${item.outcome?.status === 'Rejected' ? ` · ${item.outcome.code.replaceAll('_', ' ')}` : ''}`}
                          </span>
                        </div>
                        {item.state === 'DRAFT' && (
                          <>
                            <button
                              onClick={() => {
                                setDraft(item);
                                setText(item.text);
                                setCaptureScope(item.scopeId);
                                textRef.current?.focus();
                              }}
                            >
                              Continue
                            </button>
                            <button
                              aria-label="Discard draft"
                              onClick={() => {
                                void client.discardDraft(item.draftId).catch(showError);
                              }}
                            >
                              <Icon name="trash" size={17} />
                            </button>
                          </>
                        )}
                        {item.state === 'SUBMITTED' && state.recoveryRequired && (
                          <button
                            onClick={() => {
                              void client
                                .recoverDraft(item.draftId)
                                .then((value) => {
                                  if (value) {
                                    setDraft(value);
                                    setText(value.text);
                                    setCaptureScope(value.scopeId);
                                  }
                                })
                                .catch(showError);
                            }}
                          >
                            Stop old retry · keep a new draft
                          </button>
                        )}
                        {item.state === 'REJECTED' && (
                          <button
                            onClick={() => {
                              void client
                                .copyRejectedDraft(item.draftId)
                                .then((value) => {
                                  setDraft(value);
                                  setText(value.text);
                                  setCaptureScope(value.scopeId);
                                })
                                .catch(showError);
                            }}
                          >
                            Make a corrected copy
                          </button>
                        )}
                      </article>
                    ))}
                  </section>
                )}
                <section className="collection">
                  <div className="collection-heading">
                    <div>
                      <p className="eyebrow">
                        {view === 'trash'
                          ? 'Kept in history'
                          : view === 'suggestions'
                            ? 'Ideas for the app'
                            : 'A little breathing room'}
                      </p>
                      <h2>
                        {view === 'trash'
                          ? 'Recently deleted'
                          : view === 'suggestions'
                            ? 'App suggestions'
                            : 'Your inbox'}
                        <span className="count">{activeEntries.length}</span>
                      </h2>
                    </div>
                    <label className="search">
                      <Icon name="search" size={17} />
                      <input
                        aria-label={view === 'suggestions' ? 'Search suggestions' : 'Search inbox'}
                        placeholder="Find a thought…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                  </div>
                  {view === 'inbox' && (
                    <div className="tabs" aria-label="Inbox filing filter">
                      {[
                        ['unfiled', 'Unfiled'],
                        ['filed', 'Filed'],
                        ['all', 'All notes'],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          className={inboxFilter === value ? 'active' : ''}
                          onClick={() => setInboxFilter(value!)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                  {view === 'suggestions' && (
                    <div className="tabs" aria-label="Suggestion status filter">
                      {(['active', 'completed'] as const).map((value) => (
                        <button
                          key={value}
                          className={suggestionFilter === value ? 'active' : ''}
                          aria-pressed={suggestionFilter === value}
                          onClick={() => {
                            setSuggestionFilter(value);
                            setLimit(24);
                          }}
                        >
                          {value === 'active' ? 'Active' : 'Completed'}
                        </button>
                      ))}
                    </div>
                  )}
                  {view === 'suggestions' && (
                    <SuggestionReleasePanel client={client} state={state} onError={showError} />
                  )}
                  <div className="list-controls">
                    <div className="tabs" aria-label="Visibility filter">
                      <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
                        Everything
                      </button>
                      {state.session.scopes.map((s) => (
                        <button
                          key={s.scopeId}
                          className={scope === s.scopeId ? 'active' : ''}
                          onClick={() => setScope(s.scopeId)}
                        >
                          {s.kind === 'shared' ? (
                            'Shared'
                          ) : (
                            <>
                              <Icon name="lock" size={13} />
                              Just me
                            </>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="list-options">
                      <select aria-label="Sort inbox" value={sort} onChange={(e) => setSort(e.target.value)}>
                        <option value="newest">Newest first</option>
                        <option value="oldest">Oldest first</option>
                      </select>
                      <select
                        aria-label="Entries per page"
                        value={limit}
                        onChange={(e) => setLimit(Number(e.target.value))}
                      >
                        <option value={12}>Show 12</option>
                        <option value={24}>Show 24</option>
                        <option value={48}>Show 48</option>
                        <option value={2000}>Show all</option>
                      </select>
                    </div>
                  </div>
                  {activeEntries.length === 0 ? (
                    <div className="empty">
                      <span>
                        <Icon name={view === 'trash' ? 'trash' : 'inbox'} size={32} />
                      </span>
                      <h3>
                        {search
                          ? 'Nothing matches yet.'
                          : view === 'trash'
                            ? 'Nothing in the bin.'
                            : view === 'suggestions'
                              ? suggestionFilter === 'completed'
                                ? 'No completed suggestions yet.'
                                : 'Room for your next idea.'
                              : inboxFilter === 'filed'
                                ? 'No filed notes here yet.'
                                : 'A little space for whatever comes next.'}
                      </h3>
                      <p>
                        {search
                          ? 'Try a different word or visibility filter.'
                          : view === 'trash'
                            ? 'Entries you delete will appear here.'
                            : view === 'suggestions'
                              ? suggestionFilter === 'completed'
                                ? 'Suggestions you mark completed will appear here, with their discussions.'
                                : 'Save an improvement above. It stays separate from your household inbox.'
                              : inboxFilter === 'filed'
                                ? 'File a note into a task, shopping item or project. Its original capture stays here.'
                                : 'Capture anything above, then file it when you’re ready.'}
                      </p>
                    </div>
                  ) : (
                    <div className="entry-grid">
                      {activeEntries.slice(0, limit).map((entry) => (
                        <article
                          className={`entry-card ${categoryOf(entry) === 'app_suggestion' ? 'suggestion-card' : ''} ${categoryOf(entry) === 'app_suggestion' && suggestionUnread(state.suggestions, entry.inboxId) ? 'has-suggestion-update' : ''}`}
                          key={entry.inboxId}
                          data-suggestion-status={
                            categoryOf(entry) === 'app_suggestion'
                              ? suggestionStatus(state.suggestions, entry.inboxId)
                              : undefined
                          }
                        >
                          {entry.attachments[0] && (
                            <button
                              className="entry-image"
                              aria-label="Open photo entry"
                              onClick={() => setSelected({ id: entry.inboxId, history: false })}
                            >
                              <Photo client={client} id={entry.attachments[0].mediaId} />
                              {entry.attachments.length > 1 && (
                                <span className="photo-count">+{entry.attachments.length - 1}</span>
                              )}
                            </button>
                          )}
                          <div className="entry-content">
                            <div className="entry-meta">
                              {categoryOf(entry) === 'app_suggestion' && (
                                <span className="scope-badge">
                                  {suggestionStatus(state.suggestions, entry.inboxId)}
                                </span>
                              )}
                              {categoryOf(entry) === 'app_suggestion' &&
                                suggestionUnread(state.suggestions, entry.inboxId) && (
                                  <span className="suggestion-unread">
                                    <span aria-hidden="true">●</span>
                                    <span>New update</span>
                                  </span>
                                )}
                              <span
                                className={`scope-badge ${entry.scopeId === sharedScope ? '' : 'private'}`}
                              >
                                {entry.scopeId === sharedScope ? (
                                  'Shared with us'
                                ) : (
                                  <>
                                    <Icon name="lock" size={12} />
                                    Just me
                                  </>
                                )}
                              </span>
                              <time dateTime={new Date(entry.createdAt).toISOString()}>
                                {date(entry.createdAt)}
                              </time>
                            </div>
                            <div
                              className="entry-body"
                              onClick={() => setSelected({ id: entry.inboxId, history: false })}
                            >
                              <p className="entry-text">
                                <LinkedText client={client} text={entry.text || 'A picture to remember'} />
                              </p>
                            </div>
                            {categoryOf(entry) === 'app_suggestion' && (
                              <SuggestionCardUpdate
                                snapshot={state.suggestions}
                                id={entry.inboxId}
                                open={() => setSelected({ id: entry.inboxId, history: false })}
                              />
                            )}
                            <FilingLinks
                              entry={entry}
                              state={state}
                              open={openLinkedRecord}
                              remove={(recordId) =>
                                void runCommand(
                                  entry,
                                  'RemoveInboxDestination',
                                  { inboxId: entry.inboxId, expectedRevision: entry.revision, recordId },
                                  'Destination unlinked',
                                )
                              }
                            />
                            <CaptureSources recordId={entry.inboxId} state={state} />
                            <div className="entry-actions">
                              {view === 'suggestions' && (
                                <SuggestionCompletionButton
                                  client={client}
                                  state={state}
                                  id={entry.inboxId}
                                  onError={showError}
                                />
                              )}
                              {view !== 'trash' && categoryOf(entry) === 'inbox' && (
                                <button
                                  disabled={
                                    state.pendingEdits.includes(entry.inboxId) ||
                                    filingOf(entry).filedAt !== null
                                  }
                                  onClick={() => setFilingId(entry.inboxId)}
                                >
                                  {entry.filingAdvice?.state === 'complete'
                                    ? entry.filingAdvice.count
                                      ? `Review ${entry.filingAdvice.count} filing suggestions`
                                      : 'No filing match'
                                    : entry.filingAdvice?.state === 'attempted'
                                      ? 'Filing suggestions pending'
                                      : entry.filingAdvice?.state === 'stale'
                                        ? 'Filing suggestions changed'
                                        : entry.filingAdvice?.state === 'failed'
                                          ? 'Retry filing suggestions'
                                          : 'Filing suggestions'}
                                </button>
                              )}
                              {view !== 'trash' && categoryOf(entry) === 'inbox' && (
                                <button
                                  disabled={state.pendingEdits.includes(entry.inboxId)}
                                  onClick={() => setFilingId(entry.inboxId)}
                                >
                                  File
                                </button>
                              )}
                              {view !== 'trash' &&
                                categoryOf(entry) === 'inbox' &&
                                filingOf(entry).filedAt !== null && (
                                  <button
                                    disabled={!state.online || state.pendingEdits.includes(entry.inboxId)}
                                    onClick={() =>
                                      void runCommand(
                                        entry,
                                        'ReturnInboxEntry',
                                        { inboxId: entry.inboxId, expectedRevision: entry.revision },
                                        'Returned to inbox',
                                      )
                                    }
                                  >
                                    Back to inbox
                                  </button>
                                )}
                              <button
                                disabled={
                                  view === 'trash' &&
                                  (!state.online || state.pendingEdits.includes(entry.inboxId))
                                }
                                onClick={() => {
                                  if (view === 'trash')
                                    void runCommand(
                                      entry,
                                      'RestoreInboxEntry',
                                      { inboxId: entry.inboxId, expectedRevision: entry.revision },
                                      'Entry restored',
                                    );
                                  else setSelected({ id: entry.inboxId, history: false });
                                }}
                              >
                                {view === 'trash'
                                  ? 'Restore'
                                  : !state.online || state.pendingEdits.includes(entry.inboxId)
                                    ? 'View'
                                    : 'Edit'}
                              </button>
                              <button onClick={() => setSelected({ id: entry.inboxId, history: true })}>
                                <Icon name="clock" size={14} />
                                History
                              </button>
                              {view !== 'trash' && (
                                <button
                                  aria-label={
                                    categoryOf(entry) === 'app_suggestion'
                                      ? 'Move to inbox'
                                      : 'Move to app suggestions'
                                  }
                                  disabled={!state.online || state.pendingEdits.includes(entry.inboxId)}
                                  onClick={() => {
                                    void runCommand(
                                      entry,
                                      'SetInboxEntryCategory',
                                      {
                                        inboxId: entry.inboxId,
                                        expectedRevision: entry.revision,
                                        category:
                                          categoryOf(entry) === 'app_suggestion' ? 'inbox' : 'app_suggestion',
                                      },
                                      categoryOf(entry) === 'app_suggestion'
                                        ? 'Moved to inbox'
                                        : 'Moved to app suggestions',
                                    );
                                  }}
                                >
                                  {categoryOf(entry) === 'app_suggestion' ? 'To inbox' : 'Suggest'}
                                </button>
                              )}
                              <span className="action-spacer" />
                              {state.pendingEdits.includes(entry.inboxId) ? (
                                <span className="fine">Awaiting reply</span>
                              ) : (
                                view !== 'trash' && (
                                  <button
                                    aria-label="Delete entry"
                                    disabled={!state.online}
                                    onClick={() => {
                                      void runCommand(
                                        entry,
                                        'DeleteInboxEntry',
                                        { inboxId: entry.inboxId, expectedRevision: entry.revision },
                                        'Moved to recently deleted',
                                      );
                                    }}
                                  >
                                    <Icon name="trash" size={16} />
                                  </button>
                                )
                              )}
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  {activeEntries.length > limit && (
                    <button className="load-more" onClick={() => setLimit((value) => value + 24)}>
                      Show more · {activeEntries.length - limit} remaining
                    </button>
                  )}
                  <div className="collection-footer">
                    <span>
                      <Icon name={state.online ? 'check' : 'clock'} size={14} />
                      {state.sampledAt
                        ? `Last refreshed ${date(state.sampledAt)}`
                        : 'Your shared inbox will appear after the first connection.'}
                    </span>
                    <span>Small things, remembered.</span>
                  </div>
                </section>
              </>
            )}
          </main>
          {selectedEntry && selected && (
            <EntryDialog
              state={state}
              key={`${state.session.clientId}:${state.session.serverEpoch}:${selected.id}`}
              client={client}
              serverEpoch={state.session.serverEpoch}
              entry={selectedEntry}
              startHistory={selected.history}
              online={state.online}
              pending={state.pendingEdits.includes(selectedEntry.inboxId)}
              close={() => setSelected(null)}
              run={runCommand}
              onPhotosSaved={acceptOutcome}
              onError={showError}
            />
          )}
          {filingEntry && (
            <FilingDialog
              key={`${state.session.clientId}:${filingEntry.inboxId}`}
              client={client}
              state={state}
              entry={filingEntry}
              run={runCommand}
              onError={showError}
              close={() => setFilingId(null)}
            />
          )}
          {toast && (
            <div className="toast" role="status">
              <Icon name="check" />
              <span>{toast.label}</span>
              <button
                disabled={!state.online}
                title={toast.redo ? 'Ctrl+Shift+Z' : 'Ctrl+Z'}
                onClick={() => {
                  void reverseLatest();
                }}
              >
                {toast.redo ? 'Redo' : 'Undo'}
              </button>
              <button aria-label="Dismiss confirmation" onClick={() => setToast(null)}>
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
        </div>
      )}
    </NoteLinksProvider>
  );
}
