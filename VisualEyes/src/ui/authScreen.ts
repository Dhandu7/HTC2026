// The sign-in screen, shown before the start screen. The buttons hand over to Auth0's sign-in page, which handles
// passwords, sign-up, "forgot password" and social logins, then sends the person back here. A carer often does this,
// so targets are large. "Use without an account" keeps the app fully usable offline.

export interface AuthScreenDeps {
  root: HTMLElement;
  /** null when sign-in can't be offered here; the text says why. */
  unavailable: () => string | null;
  signIn: (signUp: boolean) => Promise<void>;
  onSkip: () => void;
}

export function mountAuthScreen(d: AuthScreenDeps) {
  function render(error = "") {
    const why = d.unavailable();
    d.root.innerHTML = `
      <div class="auth-card">
        <h1>GazeType</h1>
        <h2>Welcome</h2>
        <p class="fine">Sign in to keep your settings, profile and voice with you on any computer.</p>
        ${
          why
            ? `<p class="auth-error" role="status">${why}</p>`
            : `<button type="button" class="primary auth-submit" data-signup="0">Sign in</button>
               <button type="button" class="auth-switch" data-signup="1">Create an account</button>`
        }
        <p class="auth-error" role="alert" aria-live="assertive"></p>
        <button type="button" class="auth-skip">Use without an account (this computer only)</button>
      </div>`;
    d.root.querySelectorAll<HTMLElement>(".auth-error")[why ? 1 : 0].textContent = error;
    for (const b of d.root.querySelectorAll<HTMLButtonElement>("[data-signup]")) {
      b.addEventListener("click", async () => {
        const all = [...d.root.querySelectorAll<HTMLButtonElement>("[data-signup]")];
        for (const x of all) x.disabled = true;
        b.textContent = "Opening sign-in…";
        try {
          await d.signIn(b.dataset.signup === "1"); // navigates away to Auth0
        } catch (e) {
          render(`Couldn't open sign-in: ${(e as Error).message}`);
        }
      });
    }
    d.root.querySelector(".auth-skip")!.addEventListener("click", () => d.onSkip());
  }

  return {
    show() {
      render();
      d.root.hidden = false;
      d.root.querySelector<HTMLButtonElement>("button")?.focus();
    },
    hide() {
      d.root.hidden = true;
      d.root.innerHTML = "";
    },
  };
}
