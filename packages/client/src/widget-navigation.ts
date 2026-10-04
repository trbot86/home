import type { ClientState, WidgetNavigation } from './index.js';
export function widgetNavigationError(state: ClientState, request: WidgetNavigation): string | null {
  if (!state.session || state.session.clientId !== request.clientId)
    return 'This widget belongs to another profile. Switch to that profile or change the widget’s settings.';
  if (state.recoveryRequired || state.session.serverEpoch !== request.serverEpoch)
    return 'The server was restored. Check recovery in the app, then set up this widget again.';
  if (request.action === 'agenda') return null;
  if (!['show', 'complete', 'postpone'].includes(request.action))
    return 'This widget shortcut is unavailable.';
  const occurrence = state.tasks.occurrences.find(
    (o) => o.recordId === request.recordId && o.deletedAt === null,
  );
  const task = state.tasks.definitions.find((t) => t.recordId === occurrence?.taskId && t.deletedAt === null);
  if (
    !task ||
    !occurrence ||
    task.scopeId !== occurrence.scopeId ||
    !state.session.scopes.some((s) => s.scopeId === task.scopeId)
  )
    return 'This task is no longer available. Refresh the widget for the current list.';
  if (request.action !== 'show' && occurrence.state !== 'open')
    return 'This task occurrence is no longer open. Refresh the widget for the current list.';
  return null;
}
