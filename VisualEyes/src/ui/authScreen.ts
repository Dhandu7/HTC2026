// The sign-in and create-account pages. Shown before the start screen; a carer often fills them in, so targets are
// large and every error says what to do next. "Use without an account" keeps the app fully usable offline.
import { AccountError, checkSignUp, MIN_PASSWORD, type AccountApi, type Session } from "../account/account";

export interface AuthScreenDeps {
  root: HTMLElement;
  api: AccountApi;
  onSignedIn: (s: Session, isNew: boolean) => void;
  onSkip: () => void;
}

type Mode = "signin" | "signup";

export function mountAuthScreen(d: AuthScreenDeps) {
  let mode: Mode = "signin";
  let busy = false;

  function field(id: string, label: string, type: string, autocomplete: string, extra = ""): string {
    return `<label class="auth-field" for="${id}">${label}<input id="${id}" name="${id}" type="${type}" autocomplete="${autocomplete}" required ${extra} /></label>`;
  }

  function render() {
    const signup = mode === "signup";
    d.root.innerHTML = `
      <form class="auth-card" novalidate>
        <h1>GazeType</h1>
        <h2>${signup ? "Create your account" : "Sign in"}</h2>
        <p class="fine">${signup ? "Your settings and profile follow you to any computer you sign in on." : "Sign in to load your settings, profile and voice."}</p>
        ${signup ? field("auth-name", "Your name", "text", "name", 'maxlength="60"') : ""}
        ${field("auth-email", "Email", "email", "email", 'inputmode="email" autocapitalize="off" spellcheck="false"')}
        ${field("auth-password", "Password", "password", signup ? "new-password" : "current-password", `minlength="${signup ? MIN_PASSWORD : 1}"`)}
        ${signup ? field("auth-confirm", "Password again", "password", "new-password") : ""}
        <label class="auth-show"><input type="checkbox" id="auth-show" /> Show password</label>
        ${signup ? `<p class="fine">At least ${MIN_PASSWORD} characters. A short sentence is easy to remember and hard to guess.</p>` : ""}
        <p class="auth-error" role="alert" aria-live="assertive"></p>
        <button type="submit" class="primary auth-submit">${signup ? "Create account" : "Sign in"}</button>
        <button type="button" class="auth-switch">${signup ? "I already have an account: sign in" : "New here? Create an account"}</button>
        <button type="button" class="auth-skip">Use without an account (this computer only)</button>
      </form>`;
    const form = d.root.querySelector<HTMLFormElement>("form")!;
    const q = <T extends HTMLElement>(s: string) => d.root.querySelector<T>(s)!;
    const err = q<HTMLElement>(".auth-error");
    const pw = () => [...d.root.querySelectorAll<HTMLInputElement>('input[id^="auth-password"], #auth-confirm')];

    q<HTMLInputElement>("#auth-show").addEventListener("change", (e) => {
      for (const i of pw()) i.type = (e.target as HTMLInputElement).checked ? "text" : "password";
    });
    q(".auth-switch").addEventListener("click", () => {
      mode = signup ? "signin" : "signup";
      const email = q<HTMLInputElement>("#auth-email").value;
      render();
      q<HTMLInputElement>("#auth-email").value = email; // keep what they already typed
      q<HTMLInputElement>(mode === "signup" ? "#auth-name" : "#auth-email").focus();
    });
    q(".auth-skip").addEventListener("click", () => d.onSkip());

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const email = q<HTMLInputElement>("#auth-email").value.trim();
      const password = q<HTMLInputElement>("#auth-password").value;
      let problem: string | null = null;
      if (signup) {
        const name = q<HTMLInputElement>("#auth-name").value.trim();
        problem = name ? checkSignUp(email, password, q<HTMLInputElement>("#auth-confirm").value) : "Enter your name.";
      } else if (!email || !password) problem = "Enter your email and password.";
      if (problem) return void (err.textContent = problem);

      busy = true;
      err.textContent = "";
      const submit = q<HTMLButtonElement>(".auth-submit");
      submit.disabled = true;
      submit.textContent = signup ? "Creating your account…" : "Signing in…";
      try {
        const s = signup ? await d.api.signUp(email, password, q<HTMLInputElement>("#auth-name").value.trim()) : await d.api.signIn(email, password);
        for (const i of pw()) i.value = ""; // don't leave the password sitting in the page
        d.onSignedIn(s, signup);
      } catch (ex) {
        const ae = ex instanceof AccountError ? ex : new AccountError(String(ex));
        err.textContent = ae.status === 409 ? "An account with this email already exists. Sign in instead." : ae.message;
        submit.disabled = false;
        submit.textContent = signup ? "Create account" : "Sign in";
      } finally {
        busy = false;
      }
    });
  }

  return {
    show(m: Mode = "signin") {
      mode = m;
      render();
      d.root.hidden = false;
      d.root.querySelector<HTMLInputElement>(mode === "signup" ? "#auth-name" : "#auth-email")?.focus();
    },
    hide() {
      d.root.hidden = true;
      d.root.innerHTML = "";
    },
  };
}
