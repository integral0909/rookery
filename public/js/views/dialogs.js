import { api } from '../api.js';
import { avatar, h, icon, replace, toast } from '../dom.js';

// A modal <dialog>. Resolves with whatever `done(value)` is called with, or
// undefined when dismissed. Focus returns to where it was.
export function modal(title, build, { wide = false } = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const dialog = h('dialog.modal', { class: wide ? 'wide' : '', 'aria-label': title });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      previous?.focus?.();
      resolve(value);
    };
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(undefined);
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) done(undefined);
    });
    const body = h('div.modal-body');
    dialog.append(h('header.modal-header', h('h2', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => done(undefined) }, icon('x'))), body);
    build(body, done);
    document.body.append(dialog);
    dialog.showModal();
    (dialog.querySelector('[autofocus]') || dialog.querySelector('input, textarea, select, button.primary'))?.focus();
  });
}

function field(label, input, hint) {
  return h('label.field', h('span.label', label), input, hint ? h('span.hint', hint) : null);
}

function errorLine() {
  return h('p.error', { role: 'alert', hidden: true });
}

function showError(el, err) {
  el.textContent = err.message || String(err);
  el.hidden = false;
}

export function confirmDialog(title, text, action = 'OK') {
  return modal(title, (body, done) => {
    body.append(
      text ? h('p', text) : null,
      h('div.modal-actions', h('button.ghost', { type: 'button', onclick: () => done(false) }, 'Cancel'), h('button.primary.danger', { type: 'button', autofocus: true, onclick: () => done(true) }, action)),
    );
  }).then(Boolean);
}

export function textDialog(title, { label, value = '', placeholder = '', action = 'Save', maxlength = 250, onSubmit }) {
  return modal(title, (body, done) => {
    const input = h('input', { value, placeholder, maxlength, autofocus: true });
    const err = errorLine();
    body.append(
      h(
        'form',
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              done(await onSubmit(input.value));
            } catch (error) {
              showError(err, error);
            }
          },
        },
        field(label, input),
        err,
        h('div.modal-actions', h('button.ghost', { type: 'button', onclick: () => done(undefined) }, 'Cancel'), h('button.primary', { type: 'submit' }, action)),
      ),
    );
  });
}

// A search-as-you-type list of people with checkboxes.
function userPicker(app, { exclude = new Set(), max = Infinity } = {}) {
  const chosen = new Map();
  const search = h('input', { type: 'search', placeholder: 'Find people by name', autocomplete: 'off', autofocus: true, 'aria-label': 'Find people' });
  const chips = h('div.chips');
  const list = h('ul.pick-list', { role: 'listbox', 'aria-multiselectable': 'true' });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const people = [...app.store.users.values()]
      .filter((u) => !u.deactivated && u.id !== app.store.me.id && !exclude.has(u.id))
      .filter((u) => !q || u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .slice(0, 50);
    replace(
      chips,
      [...chosen.values()].map((u) => h('button.chip', { type: 'button', onclick: () => (chosen.delete(u.id), render()), 'aria-label': `Remove ${u.displayName}` }, u.displayName, ' ×')),
    );
    replace(
      list,
      people.length ? null : h('li.muted', 'Nobody matches.'),
      people.map((u) => {
        const on = chosen.has(u.id);
        return h(
          'li',
          { role: 'option', 'aria-selected': String(on) },
          h(
            'label.pick',
            h('input', {
              type: 'checkbox',
              checked: on,
              disabled: !on && chosen.size >= max,
              onchange: (e) => {
                if (e.target.checked) chosen.set(u.id, u);
                else chosen.delete(u.id);
                render();
              },
            }),
            avatar(u, 24),
            h('span', u.displayName),
            h('span.muted', `@${u.username}`),
            app.store.online.has(u.id) ? h('span.presence.online') : null,
          ),
        );
      }),
    );
  };
  search.addEventListener('input', render);
  render();
  return { el: h('div.user-picker', search, chips, list), chosen };
}

export function newDmDialog(app) {
  return modal('New message', (body, done) => {
    const picker = userPicker(app, { max: 8 });
    const err = errorLine();
    body.append(
      h('p.muted', 'Pick one person for a direct message, or up to eight for a group conversation.'),
      picker.el,
      err,
      h(
        'div.modal-actions',
        h('button.ghost', { type: 'button', onclick: () => done(undefined) }, 'Cancel'),
        h(
          'button.primary',
          {
            type: 'button',
            onclick: async () => {
              if (!picker.chosen.size) return showError(err, new Error('Pick someone first.'));
              try {
                const { channel } = await api.openDm([...picker.chosen.keys()]);
                done(channel);
              } catch (error) {
                showError(err, error);
              }
            },
          },
          'Open conversation',
        ),
      ),
    );
  });
}

export function inviteDialog(app, channel, memberIds) {
  return modal(`Add people to #${channel.name}`, (body, done) => {
    const picker = userPicker(app, { exclude: new Set(memberIds) });
    const err = errorLine();
    body.append(
      picker.el,
      err,
      h(
        'div.modal-actions',
        h('button.ghost', { type: 'button', onclick: () => done(undefined) }, 'Cancel'),
        h(
          'button.primary',
          {
            type: 'button',
            onclick: async () => {
              if (!picker.chosen.size) return done(undefined);
              try {
                done(await api.invite(channel.id, [...picker.chosen.keys()]));
              } catch (error) {
                showError(err, error);
              }
            },
          },
          'Add',
        ),
      ),
    );
  });
}

export function browseDialog(app) {
  return modal(
    'Channels',
    (body, done) => {
      const list = h('ul.browse-list', h('li.muted', 'Loading…'));
      const filter = h('input', { type: 'search', placeholder: 'Filter channels', 'aria-label': 'Filter channels', autofocus: true });
      let all = [];
      const render = () => {
        const q = filter.value.trim().toLowerCase();
        const shown = all.filter((c) => !q || c.name.includes(q) || c.topic.toLowerCase().includes(q));
        replace(
          list,
          shown.length ? null : h('li.muted', all.length ? 'No channels match.' : 'You are in every public channel.'),
          shown.map((c) =>
            h(
              'li.browse-item',
              h('div', h('strong', `#${c.name}`), h('span.muted', ` · ${c.memberCount} ${c.memberCount === 1 ? 'member' : 'members'}`), c.topic ? h('div.muted', c.topic) : null),
              h('div.browse-actions', h('button.ghost.small', { type: 'button', onclick: () => done({ view: c.id }) }, 'View'), h('button.primary.small', { type: 'button', onclick: () => done({ join: c.id }) }, 'Join')),
            ),
          ),
        );
      };
      filter.addEventListener('input', render);
      api.browse().then(
        (data) => {
          all = data.channels;
          for (const c of all) app.store.channels.has(c.id) || app.store.channels.set(c.id, c);
          render();
        },
        (err) => replace(list, h('li.error', err.message)),
      );
      body.append(h('div.browse-top', filter, h('button.primary', { type: 'button', onclick: () => done({ create: true }) }, icon('plus'), 'Create channel')), list);
    },
    { wide: true },
  );
}

export function createChannelDialog() {
  return modal('Create a channel', (body, done) => {
    const name = h('input', { placeholder: 'e.g. marketing', maxlength: 40, autofocus: true, pattern: '[a-z0-9][a-z0-9_\\-]*', required: true });
    name.addEventListener('input', () => {
      const pos = name.selectionStart;
      name.value = name.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
      name.setSelectionRange(pos, pos);
    });
    const topic = h('input', { placeholder: 'What is it about? (optional)', maxlength: 250 });
    const priv = h('input', { type: 'checkbox' });
    const err = errorLine();
    body.append(
      h(
        'form',
        {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const { channel } = await api.createChannel({ name: name.value, topic: topic.value, private: priv.checked });
              done(channel);
            } catch (error) {
              showError(err, error);
            }
          },
        },
        field('Name', name, 'Lowercase letters, numbers, dashes and underscores.'),
        field('Topic', topic),
        h('label.check', priv, h('span', h('strong', 'Private'), ' — only invited people can see it.')),
        err,
        h('div.modal-actions', h('button.ghost', { type: 'button', onclick: () => done(undefined) }, 'Cancel'), h('button.primary', { type: 'submit' }, 'Create')),
      ),
    );
  });
}

export function channelSettingsDialog(app, channel) {
  const manage = channel.role === 'owner' || app.store.me.isAdmin;
  return modal(`#${channel.name}`, (body, done) => {
    const err = errorLine();
    const name = h('input', { value: channel.name, maxlength: 40, disabled: !manage || channel.name === 'general' });
    const topic = h('input', { value: channel.topic, maxlength: 250 });
    const save = async (e) => {
      e.preventDefault();
      try {
        const patch = { topic: topic.value };
        if (manage && name.value !== channel.name) patch.name = name.value;
        const { channel: updated } = await api.updateChannel(channel.id, patch);
        app.store.upsertChannel(updated);
        done(true);
      } catch (error) {
        showError(err, error);
      }
    };
    body.append(
      h(
        'form',
        { onsubmit: save },
        field('Name', name, manage ? '' : 'Only channel owners can rename.'),
        field('Topic', topic),
        err,
        h('div.modal-actions', h('button.primary', { type: 'submit' }, 'Save')),
      ),
      h('hr'),
      h(
        'div.danger-zone',
        channel.name !== 'general'
          ? h(
              'button.ghost',
              {
                type: 'button',
                onclick: async () => {
                  try {
                    await api.leave(channel.id);
                    app.store.removeChannel(channel.id);
                    done('left');
                  } catch (error) {
                    showError(err, error);
                  }
                },
              },
              'Leave channel',
            )
          : null,
        manage && channel.name !== 'general'
          ? h(
              'button.ghost.danger',
              {
                type: 'button',
                onclick: async () => {
                  try {
                    const { channel: updated } = await api.updateChannel(channel.id, { archived: !channel.archived });
                    app.store.upsertChannel(updated);
                    done(true);
                  } catch (error) {
                    showError(err, error);
                  }
                },
              },
              channel.archived ? 'Unarchive channel' : 'Archive channel',
            )
          : null,
      ),
    );
  });
}

export function profileDialog(app, userId) {
  const user = app.store.user(userId);
  return modal(user.displayName, (body, done) => {
    const online = app.store.online.has(user.id);
    body.append(
      h(
        'div.profile',
        avatar(user, 72),
        h('div', h('div.profile-name', user.displayName), h('div.muted', `@${user.username}`), h('div', h('span.presence', { class: online ? 'online' : '' }), online ? ' Online' : ' Away'), user.isAdmin ? h('span.badge.muted', 'admin') : null),
      ),
      user.id !== app.store.me.id && !user.deactivated
        ? h('div.modal-actions', h('button.primary', { type: 'button', autofocus: true, onclick: () => done('message') }, 'Message'))
        : null,
    );
  });
}

export function settingsDialog(app) {
  return modal(
    'Settings',
    (body, done) => {
      const me = app.store.me;
      const err = errorLine();
      const name = h('input', { value: me.displayName, maxlength: 64 });
      const current = h('input', { type: 'password', autocomplete: 'current-password' });
      const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
      const status = h('p.ok', { role: 'status', hidden: true });
      const ok = (text) => {
        status.textContent = text;
        status.hidden = false;
        err.hidden = true;
      };
      const notifyState = h('span.muted');
      const describe = () => {
        const p = 'Notification' in window ? Notification.permission : 'unsupported';
        notifyState.textContent = { granted: 'Desktop notifications are on.', denied: 'Desktop notifications are blocked in this browser.', default: 'Desktop notifications are off.', unsupported: 'This browser has no desktop notifications.' }[p];
      };
      describe();

      body.append(
        h(
          'form',
          {
            onsubmit: async (e) => {
              e.preventDefault();
              try {
                const { user } = await api.updateMe(name.value);
                app.store.setMe(user);
                app.store.users.set(user.id, user);
                ok('Profile saved.');
              } catch (error) {
                showError(err, error);
              }
            },
          },
          h('h3', 'Profile'),
          field('Display name', name),
          h('div.modal-actions', h('button.primary', { type: 'submit' }, 'Save profile')),
        ),
        h(
          'form',
          {
            onsubmit: async (e) => {
              e.preventDefault();
              try {
                await api.changePassword(current.value, next.value);
                current.value = next.value = '';
                ok('Password changed. Other sessions were signed out.');
              } catch (error) {
                showError(err, error);
              }
            },
          },
          h('h3', 'Password'),
          field('Current password', current),
          field('New password', next, 'At least 8 characters.'),
          h('div.modal-actions', h('button.ghost', { type: 'submit' }, 'Change password')),
        ),
        h(
          'div',
          h('h3', 'Notifications'),
          h(
            'p',
            notifyState,
            ' ',
            'Notification' in window && Notification.permission === 'default'
              ? h('button.ghost.small', { type: 'button', onclick: () => Notification.requestPermission().then(describe) }, 'Turn on')
              : null,
          ),
        ),
        status,
        err,
        me.isAdmin ? adminSection(app) : null,
        h('hr'),
        h('div.modal-actions', h('button.ghost.danger', { type: 'button', onclick: () => done('logout') }, 'Sign out')),
      );
    },
    { wide: true },
  );
}

function adminSection(app) {
  const wrap = h('div.admin', h('h3', 'Administration'), h('p.muted', 'Loading…'));
  Promise.all([api.adminSettings(), api.users()]).then(([settings, { users }]) => {
    const signup = h('input', {
      type: 'checkbox',
      checked: settings.openSignup,
      onchange: async (e) => {
        try {
          await api.updateAdminSettings({ openSignup: e.target.checked });
          toast(e.target.checked ? 'Anyone can now sign up.' : 'Sign-up is closed.');
        } catch (err) {
          e.target.checked = !e.target.checked;
          toast(err.message, 'error');
        }
      },
    });
    const rows = users.map((u) => {
      const self = u.id === app.store.me.id;
      const toggle = (key, label) =>
        h(
          'label.check.small',
          h('input', {
            type: 'checkbox',
            checked: key === 'active' ? !u.deactivated : u.isAdmin,
            disabled: self,
            onchange: async (e) => {
              try {
                const patch = key === 'active' ? { deactivated: !e.target.checked } : { isAdmin: e.target.checked };
                const { user } = await api.updateUser(u.id, patch);
                app.store.users.set(user.id, user);
              } catch (err) {
                e.target.checked = !e.target.checked;
                toast(err.message, 'error');
              }
            },
          }),
          label,
        );
      return h('tr', h('td', avatar(u, 20), ' ', u.displayName), h('td.muted', `@${u.username}`), h('td', toggle('active', 'active')), h('td', toggle('admin', 'admin')));
    });
    replace(
      wrap,
      h('h3', 'Administration'),
      h('label.check', signup, h('span', 'Allow anyone to create an account')),
      h('div.table-wrap', h('table.users-table', h('thead', h('tr', h('th', 'Name'), h('th', 'Username'), h('th', 'Account'), h('th', 'Role'))), h('tbody', rows))),
    );
  }, (err) => replace(wrap, h('h3', 'Administration'), h('p.error', err.message)));
  return wrap;
}
