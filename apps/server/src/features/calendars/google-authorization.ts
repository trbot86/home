import { OAuth2Client, CodeChallengeMethod, gaxios, type Credentials } from 'google-auth-library';
import { CalendarProviderError } from './provider.js';
import {
  calendarGrant,
  calendarReadScopes,
  type CalendarAuthorizationProvider,
  type CalendarGrant,
} from './authorization-provider.js';

export type GoogleAuthorizationConfig = { clientId: string; clientSecret: string; redirectUri: string };
type ClientFactory = (cancellation?: AbortSignal) => OAuth2Client;
/** Uses Google's OAuth library; the injected factory is solely for isolated transport tests. */
export class GoogleCalendarAuthorization implements CalendarAuthorizationProvider {
  readonly clientId: string;
  private readonly factory: ClientFactory;
  constructor(
    private readonly config: GoogleAuthorizationConfig,
    factory?: ClientFactory,
    private readonly now = Date.now,
  ) {
    const redirect = new URL(config.redirectUri);
    if (
      !config.clientId ||
      config.clientId.length > 512 ||
      !config.clientSecret ||
      config.clientSecret.length > 4096 ||
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      redirect.search ||
      !(
        redirect.protocol === 'https:' ||
        (redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname))
      )
    )
      throw new Error('Invalid Google calendar authorization configuration');
    this.clientId = config.clientId;
    this.factory =
      factory ??
      ((signal) =>
        new OAuth2Client({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri: config.redirectUri,
          transporterOptions: {
            signal: signal ?? null,
            timeout: 20000,
            maxContentLength: 131072,
            maxRedirects: 0,
          },
        }));
  }
  private client(signal?: AbortSignal) {
    const client = this.factory(signal);
    // Authorization codes are one-use. Do not automatically replay an uncertain exchange.
    client.transporter.interceptors.request.add({
      resolved: async (options) => {
        options.retry = false;
        options.retryConfig = { ...options.retryConfig, retry: 0 };
        options.redirect = 'error';
        options.signal = signal ?? null;
        return options;
      },
    });
    return client;
  }
  authorizationUrl(state: string, codeChallenge: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))
      throw new Error('Invalid authorization challenge');
    return this.client().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent select_account',
      scope: [...calendarReadScopes],
      include_granted_scopes: false,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
  }
  private async grant(
    client: OAuth2Client,
    tokens: Credentials,
    previous?: CalendarGrant,
  ): Promise<CalendarGrant> {
    if (!tokens.access_token || tokens.token_type?.toLowerCase() !== 'bearer')
      throw new CalendarProviderError('authentication_required');
    const info = await client.getTokenInfo(tokens.access_token);
    if (
      info.aud !== this.clientId ||
      !Array.isArray(info.scopes) ||
      !calendarReadScopes.every((s) => info.scopes.includes(s))
    )
      throw new CalendarProviderError('authentication_required');
    // Obtain the stable account subject from Google's authenticated endpoint, never from an unverified JWT/email.
    const identity = await client.transporter.request<{ sub?: unknown }>({
      url: 'https://openidconnect.googleapis.com/v1/userinfo',
      method: 'GET',
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const result = calendarGrant(
      {
        clientId: this.clientId,
        subject: identity.data.sub,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? previous?.refreshToken,
        expiresAt: Math.min(tokens.expiry_date ?? 0, info.expiry_date),
        scopes: info.scopes,
      },
      this.clientId,
      this.now(),
    );
    if (previous && result.subject !== previous.subject)
      throw new CalendarProviderError('authentication_required');
    return result;
  }
  private safe(error: unknown): never {
    if (error instanceof CalendarProviderError) throw error;
    if (error instanceof gaxios.GaxiosError) {
      const data = error.response?.data as { error?: unknown } | undefined;
      if (data?.error === 'invalid_grant' || error.response?.status === 401)
        throw new CalendarProviderError('authentication_required');
      if (error.response?.status === 429) throw new CalendarProviderError('rate_limited');
    }
    // SDK errors may contain client secrets, tokens and code-bearing request bodies.
    throw new CalendarProviderError('provider_unavailable');
  }
  async exchange(code: string, verifier: string, cancellation: AbortSignal): Promise<CalendarGrant> {
    try {
      cancellation.throwIfAborted();
      if (!code || code.length > 4096 || !/^[A-Za-z0-9_-]{43}$/.test(verifier))
        throw new CalendarProviderError('authentication_required');
      const signal = AbortSignal.any([cancellation, AbortSignal.timeout(20000)]),
        client = this.client(signal);
      const { tokens } = await client.getToken({
        code,
        codeVerifier: verifier,
        redirect_uri: this.config.redirectUri,
      });
      const grant = await this.grant(client, tokens);
      signal.throwIfAborted();
      return grant;
    } catch (error) {
      return this.safe(error);
    }
  }
  async refresh(previous: CalendarGrant, cancellation: AbortSignal): Promise<CalendarGrant> {
    try {
      cancellation.throwIfAborted();
      calendarGrant(previous, this.clientId, this.now(), true);
      const signal = AbortSignal.any([cancellation, AbortSignal.timeout(20000)]),
        client = this.client(signal);
      client.setCredentials({ refresh_token: previous.refreshToken });
      // The SDK's public refresh result restores the old refresh token. Capture any provider rotation before that.
      let issued: Credentials | undefined;
      client.once('tokens', (tokens) => {
        issued = { ...tokens };
      });
      await client.refreshAccessToken();
      if (!issued) throw new CalendarProviderError('invalid_provider_response');
      const grant = await this.grant(client, issued, previous);
      signal.throwIfAborted();
      return grant;
    } catch (error) {
      return this.safe(error);
    }
  }
}
