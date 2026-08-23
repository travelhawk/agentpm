// Self-contained web UI served at "/" by the registry server. No external
// assets so the registry works fully offline. Keep this file free of
// backticks and "${" inside the HTML so the template literal stays inert.
export const WEB_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentPM Registry</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #16181d; --muted: #5b6472;
  --line: #e3e6ea; --accent: #2563eb; --accent-text: #ffffff;
  --ok: #16a34a; --warn: #b45309; --danger: #dc2626; --chip: #eef1f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101318; --panel: #181c23; --text: #e8eaee; --muted: #9aa4b2;
    --line: #262c36; --accent: #3b82f6; --accent-text: #ffffff; --chip: #222834;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--accent); text-decoration: none; }
header {
  display: flex; align-items: center; gap: 16px; padding: 14px 24px;
  background: var(--panel); border-bottom: 1px solid var(--line);
  position: sticky; top: 0; z-index: 5;
}
header h1 { font-size: 17px; margin: 0; letter-spacing: 0.2px; }
header h1 span { color: var(--accent); }
header .spacer { flex: 1; }
main { max-width: 1060px; margin: 0 auto; padding: 24px; }
.card {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: 10px; padding: 18px 20px; margin-bottom: 16px;
}
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.skill-card { cursor: pointer; transition: border-color 0.15s; }
.skill-card:hover { border-color: var(--accent); }
.skill-card h3 { margin: 0 0 6px; font-size: 16px; }
.skill-card p { margin: 0 0 10px; color: var(--muted); font-size: 13.5px; min-height: 20px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--muted); }
.chip {
  background: var(--chip); border-radius: 999px; padding: 2px 9px;
  font-size: 11.5px; color: var(--text);
}
.chip.kind { color: var(--accent); font-weight: 600; }
.chip.private { color: var(--warn); font-weight: 600; }
input, select, textarea {
  background: var(--bg); color: var(--text); border: 1px solid var(--line);
  border-radius: 8px; padding: 8px 12px; font: inherit; width: 100%;
}
input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button {
  background: var(--accent); color: var(--accent-text); border: 0;
  border-radius: 8px; padding: 8px 16px; font: inherit; font-weight: 600; cursor: pointer;
}
button.ghost { background: transparent; color: var(--accent); border: 1px solid var(--line); }
button.danger { background: var(--danger); }
button:disabled { opacity: 0.5; cursor: default; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.row > input { flex: 1; min-width: 160px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.4px; }
pre.codeblock {
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 14px; overflow-x: auto; font-size: 13px;
}
.readme {
  border-top: 1px solid var(--line); margin-top: 16px; padding-top: 16px;
  white-space: pre-wrap; font-size: 14px; overflow-wrap: anywhere;
}
.notice { color: var(--muted); font-size: 13.5px; }
.error-banner { color: var(--danger); font-size: 13.5px; margin-top: 8px; min-height: 18px; }
.stat-row { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 18px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 20px; }
.stat b { font-size: 22px; display: block; }
.stat span { color: var(--muted); font-size: 12.5px; }
.tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
.tabs button {
  background: transparent; color: var(--muted); border: 0; border-bottom: 2px solid transparent;
  border-radius: 0; padding: 8px 14px; font-weight: 600;
}
.tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
.hidden { display: none !important; }
code.inline { background: var(--chip); border-radius: 5px; padding: 1px 6px; font-size: 13px; }
</style>
</head>
<body>
<header>
  <h1><span>Agent</span>PM Registry</h1>
  <span class="notice" id="who"></span>
  <div class="spacer"></div>
  <button class="ghost" id="nav-skills">Skills</button>
  <button class="ghost hidden" id="nav-admin">Admin</button>
  <button class="ghost hidden" id="nav-tokens">Tokens</button>
  <button id="nav-auth">Sign in</button>
</header>
<main>
  <section id="view-skills">
    <div class="stat-row" id="stats"></div>
    <div class="card">
      <div class="row">
        <input id="search" placeholder="Search skills, tags, descriptions...">
      </div>
    </div>
    <div class="grid" id="skill-list"></div>
    <p class="notice" id="skills-empty" style="display:none">No skills published yet. Publish one with:<br><code class="inline">agentpm registry publish ./my-skill --registry &lt;this url&gt;</code></p>
  </section>

  <section id="view-detail" class="hidden">
    <p><a href="#" id="back-link">&larr; All skills</a></p>
    <div class="card" id="detail-card"></div>
  </section>

  <section id="view-auth" class="hidden">
    <div class="card" style="max-width:420px;margin:40px auto">
      <h2 style="margin-top:0">Sign in</h2>
      <p class="notice">Use your registry account. Tokens created here work with <code class="inline">agentpm registry login</code> too.</p>
      <div style="display:grid;gap:10px">
        <input id="login-user" placeholder="Username" autocomplete="username">
        <input id="login-pass" placeholder="Password" type="password" autocomplete="current-password">
        <button id="login-btn">Sign in</button>
        <div class="error-banner" id="login-error"></div>
      </div>
    </div>
  </section>

  <section id="view-admin" class="hidden">
    <div class="tabs">
      <button class="active" data-tab="users">Users</button>
      <button data-tab="curation">Curation</button>
    </div>
    <div id="admin-users" class="card">
      <h3 style="margin-top:0">Users</h3>
      <table id="users-table"><thead><tr><th>User</th><th>Role</th><th>Active</th><th></th></tr></thead><tbody></tbody></table>
      <h4>Create user</h4>
      <div class="row">
        <input id="new-user-name" placeholder="username">
        <select id="new-user-role" style="width:140px">
          <option value="publisher">publisher</option>
          <option value="reader">reader</option>
          <option value="admin">admin</option>
        </select>
        <button id="new-user-btn">Create</button>
      </div>
      <div class="error-banner" id="admin-error"></div>
      <p class="notice" id="new-user-result"></p>
    </div>
    <div id="admin-curation" class="card hidden">
      <h3 style="margin-top:0">Curation</h3>
      <p class="notice">Toggle visibility or remove skills. Private skills are only served to authenticated users.</p>
      <table id="curation-table"><thead><tr><th>Skill</th><th>Owner</th><th>Visibility</th><th>Downloads</th><th></th></tr></thead><tbody></tbody></table>
      <div class="error-banner" id="curation-error"></div>
    </div>
  </section>

  <section id="view-tokens" class="hidden">
    <div class="card">
      <h3 style="margin-top:0">API tokens</h3>
      <p class="notice">Use a token in the CLI: <code class="inline">agentpm registry login &lt;url&gt; --token &lt;token&gt;</code> or set <code class="inline">AGENTPM_REGISTRY_TOKEN</code>.</p>
      <table id="tokens-table"><thead><tr><th>Label</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody></tbody></table>
      <div class="row" style="margin-top:12px">
        <input id="token-label" placeholder="Token label (e.g. ci, laptop)">
        <button id="token-create">Create token</button>
      </div>
      <p class="notice" id="token-result" style="overflow-wrap:anywhere"></p>
      <div class="error-banner" id="tokens-error"></div>
    </div>
  </section>
</main>
<script>
(function () {
  'use strict';
  var token = null;
  try { token = localStorage.getItem('agentpm-registry-token'); } catch (e) { token = null; }
  var me = null;

  function api(method, url, body) {
    var headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(url, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function el(id) { return document.getElementById(id); }
  function esc(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }
  function show(view) {
    ['view-skills', 'view-detail', 'view-auth', 'view-admin', 'view-tokens'].forEach(function (id) {
      el(id).classList.toggle('hidden', id !== view);
    });
  }

  function refreshNav() {
    el('nav-admin').classList.toggle('hidden', !(me && me.role === 'admin'));
    el('nav-tokens').classList.toggle('hidden', !me);
    el('nav-auth').textContent = me ? 'Sign out' : 'Sign in';
    el('who').textContent = me ? (me.username + ' (' + me.role + ')') : '';
  }

  function loadMe() {
    if (!token) { me = null; refreshNav(); return Promise.resolve(); }
    return api('GET', '/v1/whoami').then(function (data) {
      me = data; refreshNav();
    }).catch(function () {
      me = null; token = null;
      try { localStorage.removeItem('agentpm-registry-token'); } catch (e) {}
      refreshNav();
    });
  }

  function loadStats() {
    api('GET', '/v1/stats').then(function (stats) {
      var html = '<div class="stat"><b>' + esc(stats.skills) + '</b><span>skills</span></div>' +
        '<div class="stat"><b>' + esc(stats.downloads) + '</b><span>downloads</span></div>';
      if (stats.users !== undefined) {
        html += '<div class="stat"><b>' + esc(stats.users) + '</b><span>users</span></div>';
      }
      el('stats').innerHTML = html;
    }).catch(function () { el('stats').innerHTML = ''; });
  }

  function skillCard(skill) {
    var card = document.createElement('div');
    card.className = 'card skill-card';
    var tags = (skill.tags || []).map(function (tag) {
      return '<span class="chip">' + esc(tag) + '</span>';
    }).join('');
    card.innerHTML =
      '<h3>' + esc(skill.name) + '</h3>' +
      '<p>' + esc(skill.description || 'No description') + '</p>' +
      '<div class="meta">' +
      '<span class="chip kind">' + esc(skill.kind) + '</span>' +
      (skill.target ? '<span class="chip">' + esc(skill.target) + '</span>' : '') +
      (skill.visibility === 'private' ? '<span class="chip private">private</span>' : '') +
      tags +
      '<span>v' + esc(skill.latestVersion || '?') + '</span>' +
      '<span>&darr; ' + esc(skill.downloads) + '</span>' +
      '</div>';
    card.addEventListener('click', function () { openDetail(skill.name); });
    return card;
  }

  function loadSkills() {
    var query = el('search').value.trim();
    api('GET', '/v1/skills' + (query ? ('?q=' + encodeURIComponent(query)) : '')).then(function (data) {
      var list = el('skill-list');
      list.innerHTML = '';
      (data.skills || []).forEach(function (skill) { list.appendChild(skillCard(skill)); });
      el('skills-empty').style.display = (data.skills || []).length ? 'none' : 'block';
    }).catch(function (error) {
      el('skill-list').innerHTML = '<p class="notice">' + esc(error.message) + '</p>';
    });
  }

  function installSnippet(name) {
    var origin = location.origin + location.pathname.replace(/\\/$/, '');
    return 'agentpm source add registry:' + origin + '/index.json\\n' +
      'agentpm install ' + name;
  }

  function openDetail(name) {
    show('view-detail');
    el('detail-card').innerHTML = '<p class="notice">Loading...</p>';
    api('GET', '/v1/skills/' + encodeURIComponent(name)).then(function (skill) {
      var versions = (skill.versions || []).map(function (version) {
        return '<tr><td>' + esc(version.version) + '</td><td>' + esc((version.publishedAt || '').slice(0, 10)) +
          '</td><td>' + esc(version.publishedBy || '') + '</td><td>' + esc(Math.round((version.sizeBytes || 0) / 1024)) + ' KB</td></tr>';
      }).join('');
      var manage = '';
      if (me && (me.role === 'admin' || me.username === skill.owner)) {
        manage = '<p class="row">' +
          '<button class="ghost" id="toggle-visibility">Make ' + (skill.visibility === 'public' ? 'private' : 'public') + '</button>' +
          '<button class="danger" id="delete-skill">Delete skill</button></p>' +
          '<div class="error-banner" id="detail-error"></div>';
      }
      el('detail-card').innerHTML =
        '<h2 style="margin-top:0">' + esc(skill.name) + '</h2>' +
        '<div class="meta" style="margin-bottom:12px">' +
        '<span class="chip kind">' + esc(skill.kind) + '</span>' +
        (skill.target ? '<span class="chip">' + esc(skill.target) + '</span>' : '') +
        (skill.visibility === 'private' ? '<span class="chip private">private</span>' : '') +
        (skill.tags || []).map(function (tag) { return '<span class="chip">' + esc(tag) + '</span>'; }).join('') +
        '<span>owner: ' + esc(skill.owner || '?') + '</span>' +
        '<span>&darr; ' + esc(skill.downloads) + '</span></div>' +
        '<p>' + esc(skill.description || '') + '</p>' +
        '<h4>Install</h4><pre class="codeblock">' + esc(installSnippet(skill.name)) + '</pre>' +
        manage +
        '<h4>Versions</h4><table><thead><tr><th>Version</th><th>Published</th><th>By</th><th>Size</th></tr></thead><tbody>' +
        versions + '</tbody></table>' +
        (skill.readme ? '<div class="readme">' + esc(skill.readme) + '</div>' : '');
      var toggle = el('toggle-visibility');
      if (toggle) {
        toggle.addEventListener('click', function () {
          api('PATCH', '/v1/skills/' + encodeURIComponent(name), {
            visibility: skill.visibility === 'public' ? 'private' : 'public'
          }).then(function () { openDetail(name); loadSkills(); }).catch(function (error) {
            el('detail-error').textContent = error.message;
          });
        });
      }
      var remove = el('delete-skill');
      if (remove) {
        remove.addEventListener('click', function () {
          if (!confirm('Delete skill "' + name + '" and all its versions?')) return;
          api('DELETE', '/v1/skills/' + encodeURIComponent(name)).then(function () {
            show('view-skills'); loadSkills(); loadStats();
          }).catch(function (error) { el('detail-error').textContent = error.message; });
        });
      }
    }).catch(function (error) {
      el('detail-card').innerHTML = '<p class="error-banner">' + esc(error.message) + '</p>';
    });
  }

  function loadAdmin() {
    api('GET', '/v1/users').then(function (data) {
      var tbody = el('users-table').querySelector('tbody');
      tbody.innerHTML = '';
      (data.users || []).forEach(function (user) {
        var row = document.createElement('tr');
        row.innerHTML = '<td>' + esc(user.username) + '</td>' +
          '<td><select data-user="' + esc(user.username) + '" class="role-select" style="width:130px">' +
          ['admin', 'publisher', 'reader'].map(function (role) {
            return '<option value="' + role + '"' + (user.role === role ? ' selected' : '') + '>' + role + '</option>';
          }).join('') + '</select></td>' +
          '<td>' + (user.active ? 'yes' : 'no') + '</td>' +
          '<td><button class="ghost toggle-active" data-user="' + esc(user.username) + '" data-next="' + (user.active ? 'false' : 'true') + '">' +
          (user.active ? 'Deactivate' : 'Activate') + '</button></td>';
        tbody.appendChild(row);
      });
      tbody.querySelectorAll('.role-select').forEach(function (select) {
        select.addEventListener('change', function () {
          api('PATCH', '/v1/users/' + encodeURIComponent(select.dataset.user), { role: select.value })
            .then(loadAdmin).catch(function (error) { el('admin-error').textContent = error.message; });
        });
      });
      tbody.querySelectorAll('.toggle-active').forEach(function (button) {
        button.addEventListener('click', function () {
          api('PATCH', '/v1/users/' + encodeURIComponent(button.dataset.user), { active: button.dataset.next === 'true' })
            .then(loadAdmin).catch(function (error) { el('admin-error').textContent = error.message; });
        });
      });
    }).catch(function (error) { el('admin-error').textContent = error.message; });

    api('GET', '/v1/skills').then(function (data) {
      var tbody = el('curation-table').querySelector('tbody');
      tbody.innerHTML = '';
      (data.skills || []).forEach(function (skill) {
        var row = document.createElement('tr');
        row.innerHTML = '<td>' + esc(skill.name) + '</td><td>' + esc(skill.owner || '') + '</td>' +
          '<td>' + esc(skill.visibility) + '</td><td>' + esc(skill.downloads) + '</td>' +
          '<td class="row">' +
          '<button class="ghost cur-toggle" data-name="' + esc(skill.name) + '" data-next="' + (skill.visibility === 'public' ? 'private' : 'public') + '">' +
          (skill.visibility === 'public' ? 'Make private' : 'Make public') + '</button>' +
          '<button class="danger cur-delete" data-name="' + esc(skill.name) + '">Delete</button></td>';
        tbody.appendChild(row);
      });
      tbody.querySelectorAll('.cur-toggle').forEach(function (button) {
        button.addEventListener('click', function () {
          api('PATCH', '/v1/skills/' + encodeURIComponent(button.dataset.name), { visibility: button.dataset.next })
            .then(loadAdmin).catch(function (error) { el('curation-error').textContent = error.message; });
        });
      });
      tbody.querySelectorAll('.cur-delete').forEach(function (button) {
        button.addEventListener('click', function () {
          if (!confirm('Delete skill "' + button.dataset.name + '"?')) return;
          api('DELETE', '/v1/skills/' + encodeURIComponent(button.dataset.name))
            .then(function () { loadAdmin(); loadSkills(); }).catch(function (error) { el('curation-error').textContent = error.message; });
        });
      });
    }).catch(function (error) { el('curation-error').textContent = error.message; });
  }

  function loadTokens() {
    api('GET', '/v1/tokens').then(function (data) {
      var tbody = el('tokens-table').querySelector('tbody');
      tbody.innerHTML = '';
      (data.tokens || []).forEach(function (item) {
        var row = document.createElement('tr');
        row.innerHTML = '<td>' + esc(item.label) + '</td><td>' + esc((item.createdAt || '').slice(0, 10)) + '</td>' +
          '<td>' + esc(item.lastUsedAt ? item.lastUsedAt.slice(0, 10) : 'never') + '</td>' +
          '<td><button class="ghost tok-revoke" data-id="' + esc(item.id) + '">Revoke</button></td>';
        tbody.appendChild(row);
      });
      tbody.querySelectorAll('.tok-revoke').forEach(function (button) {
        button.addEventListener('click', function () {
          api('DELETE', '/v1/tokens/' + encodeURIComponent(button.dataset.id))
            .then(loadTokens).catch(function (error) { el('tokens-error').textContent = error.message; });
        });
      });
    }).catch(function (error) { el('tokens-error').textContent = error.message; });
  }

  el('nav-skills').addEventListener('click', function () { show('view-skills'); loadSkills(); loadStats(); });
  el('nav-admin').addEventListener('click', function () { show('view-admin'); loadAdmin(); });
  el('nav-tokens').addEventListener('click', function () { show('view-tokens'); loadTokens(); });
  el('back-link').addEventListener('click', function (event) { event.preventDefault(); show('view-skills'); });
  el('nav-auth').addEventListener('click', function () {
    if (me) {
      token = null; me = null;
      try { localStorage.removeItem('agentpm-registry-token'); } catch (e) {}
      refreshNav(); show('view-skills'); loadSkills(); loadStats();
      return;
    }
    show('view-auth');
  });
  el('login-btn').addEventListener('click', function () {
    el('login-error').textContent = '';
    api('POST', '/v1/auth/login', {
      username: el('login-user').value.trim(),
      password: el('login-pass').value,
      label: 'web-ui'
    }).then(function (data) {
      token = data.token;
      try { localStorage.setItem('agentpm-registry-token', token); } catch (e) {}
      return loadMe();
    }).then(function () {
      show('view-skills'); loadSkills(); loadStats();
    }).catch(function (error) { el('login-error').textContent = error.message; });
  });
  el('login-pass').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') el('login-btn').click();
  });
  el('search').addEventListener('input', function () { loadSkills(); });
  el('new-user-btn').addEventListener('click', function () {
    el('admin-error').textContent = '';
    api('POST', '/v1/users', {
      username: el('new-user-name').value.trim(),
      role: el('new-user-role').value
    }).then(function (data) {
      el('new-user-result').textContent = data.password
        ? ('Created "' + data.username + '" with one-time password: ' + data.password)
        : ('Created "' + data.username + '"');
      el('new-user-name').value = '';
      loadAdmin();
    }).catch(function (error) { el('admin-error').textContent = error.message; });
  });
  el('token-create').addEventListener('click', function () {
    el('tokens-error').textContent = '';
    api('POST', '/v1/tokens', { label: el('token-label').value.trim() || 'api-token' })
      .then(function (data) {
        el('token-result').textContent = 'New token (copy now, it is not shown again): ' + data.token;
        el('token-label').value = '';
        loadTokens();
      }).catch(function (error) { el('tokens-error').textContent = error.message; });
  });
  document.querySelectorAll('.tabs button').forEach(function (button) {
    button.addEventListener('click', function () {
      document.querySelectorAll('.tabs button').forEach(function (other) { other.classList.remove('active'); });
      button.classList.add('active');
      el('admin-users').classList.toggle('hidden', button.dataset.tab !== 'users');
      el('admin-curation').classList.toggle('hidden', button.dataset.tab !== 'curation');
    });
  });

  loadMe().then(function () { loadSkills(); loadStats(); });
})();
</script>
</body>
</html>`;
