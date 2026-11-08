// Sign-in through Auth0 (Universal Login). Auth0 owns passwords, sign-up, email verification, resets and social logins;
// the app only ever holds Auth0's tokens, and the hosted service checks them (voice-sidecar/voice_sidecar/auth.py).
//
// Configure in VisualEyes/.env (Vite reads VITE_* at build time; none of these are secrets):
//   VITE_AUTH0_DOMAIN=your-tenant.us.auth0.com
//   VITE_AUTH0_CLIENT_ID=...            the Single Page Application's Client ID
//   VITE_AUTH0_AUDIENCE=https://...     the API Identifier (the service checks tokens are for this API)
import type { Auth0Client } from "@auth0/auth0-spa-js";

export interface Auth0Config {
  domain: string;
  clientId: string;
  audience: string;
}

export interface SignedInUser {
  sub: string;
  email?: string;
  name?: string;
}

export function auth0Config(env: Record<string, string | undefined>): Auth0Config | null {
  const domain = (env.VITE_AUTH0_DOMAIN ?? "").trim().replace(/^https:\/\//, "").replace(/\/$/, "");
  const clientId = (env.VITE_AUTH0_CLIENT_ID ?? "").trim();
  const audience = (env.VITE_AUTH0_AUDIENCE ?? "").trim();
  return domain && clientId && audience ? { domain, clientId, audience } : null;
}

/** Auth0 needs an http(s) page to return to. The packaged Electron build loads file://, where redirects can't land. */
export const canRedirect = (loc: Location = window.location): boolean => loc.protocol === "http:" || loc.protocol === "https:";

/** The page Auth0 sends people back to: this page without its query string. Add it to the Auth0 app's allowed URLs. */
export const returnUrl = (loc: Location = window.location): string => loc.origin + loc.pathname;

export class Auth0Session {
  private client: Auth0Client | null = null;

  constructor(private readonly cfg: Auth0Config) {}

  /** Loads the SDK and finishes a sign-in if Auth0 just sent us back here. Returns the signed-in user, if any. */
  async init(): Promise<SignedInUser | null> {
    const { createAuth0Client } = await import("@auth0/auth0-spa-js");
    this.client = await createAuth0Client({
      domain: this.cfg.domain,
      clientId: this.cfg.clientId,
      authorizationParams: { audience: this.cfg.audience, scope: "openid profile email offline_access", redirect_uri: returnUrl() },
      // Survive reloads and app restarts. Refresh tokens rotate, so a stolen one stops working after its next use.
      cacheLocation: "localstorage",
      useRefreshTokens: true,
      useRefreshTokensFallback: true,
    });
    const q = new URLSearchParams(window.location.search);
    if ((q.has("code") || q.has("error")) && q.has("state")) {
      try {
        await this.client.handleRedirectCallback();
      } finally {
        history.replaceState({}, document.title, returnUrl()); // drop ?code=&state= so a reload doesn't replay it
      }
    }
    return this.user();
  }

  async user(): Promise<SignedInUser | null> {
    if (!this.client || !(await this.client.isAuthenticated())) return null;
    const u = await this.client.getUser();
    return u?.sub ? { sub: u.sub, email: u.email, name: u.name } : null;
  }

  /** A fresh access token for our API, or null if signed out or the session has ended. */
  async token(): Promise<string | null> {
    if (!this.client) return null;
    try {
      return (await this.client.getTokenSilently()) || null;
    } catch {
      return null;
    }
  }

  signIn(signUp = false): Promise<void> {
    if (!this.client) return Promise.reject(new Error("Sign-in is still loading."));
    return this.client.loginWithRedirect({ authorizationParams: signUp ? { screen_hint: "signup" } : {} });
  }

  signOut(): Promise<void> {
    if (!this.client) return Promise.resolve();
    return this.client.logout({ logoutParams: { returnTo: returnUrl() } });
  }
}
