import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ClientPlatform } from '@our-place/client';
import { AppUpdates } from '../src/ui/AppUpdates.js';

const installed = { version: '1.0', sha256: 'a'.repeat(64) };
const client = { appVersion: async () => installed } as ClientPlatform;
function render(update: 'available' | 'current' | 'unavailable', online = true, notice = true) {
  return renderToStaticMarkup(
    createElement(AppUpdates, {
      client,
      online,
      notice,
      version: { installed, update },
      onError: () => {},
    }),
  );
}
test('phone notice appears only for a confirmed different published build while connected', () => {
  assert.match(render('available'), /A phone app update is available/);
  assert.equal(render('current'), '');
  assert.equal(render('unavailable'), '');
  assert.equal(render('available', false), '');
});
test('settings show installed version and build, and distinguish a failed check from current', () => {
  assert.match(render('current', true, false), /Installed phone version 1.0 · build aaaaaaaa/);
  assert.match(render('current', true, false), /Your phone has the published app/);
  assert.match(render('unavailable', true, false), /Update check unavailable/);
  assert.doesNotMatch(render('unavailable', true, false), /Your phone has the published app/);
});
