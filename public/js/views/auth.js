import { api } from '../api.js';
import { h, replace } from '../dom.js';

// Sign-in and sign-up on one card. Resolves through onSignedIn(user).
export function authView(root, onSignedIn) {
  let mode = 'login';
  const card = h('div.auth-card');
  const render = () => {
    const username = h('input', { name: 'username', autocomplete: 'username', required: true, minlength: 2, maxlength: 32, autofocus: true, autocapitalize: 'off', spellcheck: false });
    const displayName = h('input', { name: 'displayName', autocomplete: 'name', maxlength: 64 });
    const password = h('input', { name: 'password', type: 'password', required: true, minlength: mode === 'register' ? 8 : 1, autocomplete: mode === 'register' ? 'new-password' : 'current-password' });
    const error = h('p.error', { role: 'alert', hidden: true });
    const submit = h('button.primary.wide', { type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account');
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          submit.disabled = true;
          error.hidden = true;
          try {
            const { user } =
              mode === 'login'
                ? await api.login(username.value.trim(), password.value)
                : await api.register(username.value.trim(), password.value, displayName.value.trim() || undefined);
            onSignedIn(user);
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            submit.disabled = false;
          }
        },
      },
      h('label.field', h('span.label', 'Username'), username),
      mode === 'register' ? h('label.field', h('span.label', 'Display name'), displayName, h('span.hint', 'Optional; how your name appears to others.')) : null,
      h('label.field', h('span.label', 'Password'), password, mode === 'register' ? h('span.hint', 'At least 8 characters.') : null),
      error,
      submit,
    );
    replace(
      card,
      h('div.auth-logo', { 'aria-hidden': 'true' }, '🐦'),
      h('h1', mode === 'login' ? 'Sign in to Rookery' : 'Create your account'),
      form,
      h(
        'p.switch',
        mode === 'login' ? 'New here? ' : 'Already have an account? ',
        h(
          'button.linklike',
          {
            type: 'button',
            onclick: () => {
              mode = mode === 'login' ? 'register' : 'login';
              render();
            },
          },
          mode === 'login' ? 'Create an account' : 'Sign in',
        ),
      ),
    );
    username.focus();
  };
  render();
  replace(root, h('main.auth', card));
}
