import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { GoogleCalendarAuthorization } from '../src/features/calendars/google-authorization.js';
import { CalendarProviderError } from '../src/features/calendars/provider.js';
import { calendarReadScopes } from '../src/features/calendars/authorization-provider.js';
const config = {
  clientId: 'fixture-google-client',
  clientSecret: 'synthetic-client-secret',
  redirectUri: 'https://household.example/oauth/calendar/callback',
};
const signal = () => new AbortController().signal;
const verifier = () => randomBytes(32).toString('base64url');
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const isCode = (code: string) => (error: unknown) =>
  error instanceof CalendarProviderError && error.code === code;
function fixture() {
  const requests: {
    url: string;
    method: string;
    headers: Headers;
    body: string;
    redirect: RequestRedirect | undefined;
  }[] = [];
  let refreshToken: string | undefined = 'synthetic-refresh-token',
    subject = 'stable-google-subject',
    scopes = [...calendarReadScopes] as string[],
    audience = config.clientId;
  let tokenResponse: (() => Response) | undefined;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ''),
      redirect: init?.redirect,
    });
    if (url === 'https://oauth2.googleapis.com/token')
      return (
        tokenResponse?.() ??
        json({
          token_type: 'Bearer',
          access_token: 'synthetic-access-token',
          expires_in: 3600,
          ...(refreshToken ? { refresh_token: refreshToken } : {}),
          scope: scopes.join(' '),
        })
      );
    if (url === 'https://oauth2.googleapis.com/tokeninfo')
      return json({ aud: audience, scope: scopes.join(' '), expires_in: 3590 });
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo')
      return json({ sub: subject, email: 'ignored@example.com' });
    throw new Error('Unexpected SDK endpoint');
  };
  const auth = new GoogleCalendarAuthorization(
    config,
    (cancellation) =>
      new OAuth2Client({
        ...config,
        transporterOptions: { fetchImplementation: transport, signal: cancellation ?? null },
      }),
  );
  return {
    auth,
    requests,
    refresh: (v: string | undefined) => {
      refreshToken = v;
    },
    subject: (v: string) => {
      subject = v;
    },
    scopes: (v: string[]) => {
      scopes = v;
    },
    audience: (v: string) => {
      audience = v;
    },
    response: (v: () => Response) => {
      tokenResponse = v;
    },
  };
}

test('Google OAuth URL uses exact callback, minimal read grants, offline consent and S256', () => {
  const auth = new GoogleCalendarAuthorization(config),
    state = verifier(),
    challenge = verifier(),
    url = new URL(auth.authorizationUrl(state, challenge));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('client_id'), config.clientId);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(url.searchParams.get('scope')!.split(' '), [...calendarReadScopes]);
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(url.href.includes(config.clientSecret), false);
  assert.throws(
    () => new GoogleCalendarAuthorization({ ...config, redirectUri: 'http://household.example/callback' }),
    /Invalid/,
  );
  assert.throws(
    () => new GoogleCalendarAuthorization({ ...config, redirectUri: config.redirectUri + '?next=elsewhere' }),
    /Invalid/,
  );
});

test('actual Google SDK exchange keeps tokens in request bodies/headers and checks audience, scope and stable subject', async () => {
  const f = fixture(),
    pkce = verifier(),
    grant = await f.auth.exchange('synthetic-code', pkce, signal());
  assert.equal(grant.subject, 'stable-google-subject');
  assert.equal(grant.refreshToken, 'synthetic-refresh-token');
  assert.equal(grant.accessToken, 'synthetic-access-token');
  assert.equal(f.requests.length, 3);
  const exchange = new URLSearchParams(f.requests[0]!.body);
  assert.equal(exchange.get('code'), 'synthetic-code');
  assert.equal(exchange.get('code_verifier'), pkce);
  assert.equal(exchange.get('redirect_uri'), config.redirectUri);
  assert.equal(exchange.get('client_secret'), config.clientSecret);
  for (const request of f.requests) {
    assert.equal(new URL(request.url).search, '');
    assert.equal(request.redirect, 'error');
  }
  assert.equal(f.requests[1]!.headers.get('authorization'), 'Bearer synthetic-access-token');
  assert.equal(f.requests[2]!.headers.get('authorization'), 'Bearer synthetic-access-token');
  assert.equal(JSON.stringify(grant).includes('ignored@example.com'), false);
  f.audience('other-client');
  await assert.rejects(
    f.auth.exchange('synthetic-code', verifier(), signal()),
    isCode('authentication_required'),
  );
  f.audience(config.clientId);
  f.scopes(['openid']);
  await assert.rejects(
    f.auth.exchange('synthetic-code', verifier(), signal()),
    isCode('authentication_required'),
  );
  f.scopes([...calendarReadScopes]);
  f.refresh(undefined);
  await assert.rejects(
    f.auth.exchange('synthetic-code', verifier(), signal()),
    isCode('authentication_required'),
  );
});

test('Google refresh retains an omitted refresh token, captures rotation and refuses account changes', async () => {
  const f = fixture(),
    previous = await f.auth.exchange('synthetic-code', verifier(), signal());
  f.refresh(undefined);
  assert.equal((await f.auth.refresh(previous, signal())).refreshToken, previous.refreshToken);
  f.refresh('synthetic-rotated-token');
  assert.equal((await f.auth.refresh(previous, signal())).refreshToken, 'synthetic-rotated-token');
  const request = new URLSearchParams(f.requests[3]!.body);
  assert.equal(request.get('grant_type'), 'refresh_token');
  assert.equal(request.get('refresh_token'), previous.refreshToken);
  f.subject('different-google-subject');
  await assert.rejects(f.auth.refresh(previous, signal()), isCode('authentication_required'));
});

test('Google failures do not retry uncertain authorization codes or expose secret SDK diagnostics', async () => {
  for (const [status, error, expected] of [
    [400, 'invalid_grant', 'authentication_required'],
    [400, 'invalid_client', 'provider_unavailable'],
    [503, 'unavailable', 'provider_unavailable'],
    [429, 'too_many_requests', 'rate_limited'],
  ] as const) {
    const f = fixture();
    f.response(() => json({ error, error_description: 'synthetic-sensitive-diagnostic' }, status));
    await assert.rejects(f.auth.exchange('synthetic-code', verifier(), signal()), (cause) => {
      assert.ok(isCode(expected)(cause));
      assert.equal(String(cause).includes('synthetic'), false);
      return true;
    });
    assert.equal(f.requests.length, 1);
  }
  const f = fixture(),
    aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    f.auth.exchange('synthetic-code', verifier(), aborted.signal),
    isCode('provider_unavailable'),
  );
  assert.equal(f.requests.length, 0);
});
