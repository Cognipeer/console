/**
 * Props that keep browser and extension password managers out of a form that
 * holds a secret but is not a login.
 *
 * A text field followed by a password field reads as a login form to Chrome,
 * Safari, 1Password and the rest: they fill the saved username (an e-mail) into
 * the text field and the saved password into the secret. On a trigger editor
 * that put the user's e-mail into "Callback URL", and every save failed with
 * "callback.url is not a valid URL". `autocomplete="off"` alone is ignored by
 * the built-in managers; `new-password` on the secret is what makes them stop
 * filling, and the data attributes opt out of the common extensions.
 */
const EXTENSION_OPT_OUT = {
    'data-1p-ignore': true,
    'data-lpignore': 'true',
    'data-bwignore': true,
    'data-form-type': 'other',
} as const;

/** For a secret (`PasswordInput`) that is not the user's own password. */
export const NO_AUTOFILL_SECRET = { autoComplete: 'new-password', ...EXTENSION_OPT_OUT } as const;

/** For a plain field (a URL, a header name) that sits next to such a secret. */
export const NO_AUTOFILL_FIELD = { autoComplete: 'off', ...EXTENSION_OPT_OUT } as const;
